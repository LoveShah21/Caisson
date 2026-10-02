//go:build linux && diagnostic

package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

const diagnosticPort = 1026

type diagnosticRequest struct {
	Operation string `json:"operation"`
	Path      string `json:"path,omitempty"`
	Value     string `json:"value,omitempty"`
}
type diagnosticResponse struct {
	Ok    bool   `json:"ok"`
	Value string `json:"value,omitempty"`
	Error string `json:"error,omitempty"`
}

// Diagnostic builds are selected only by the test-rootfs builder. Keeping this
// file behind a build tag makes the production runtime artifact incapable of
// acquiring test commands.
const diagnosticRuntimeBuild = true

// diagnosticRandom is deliberately unavailable from the production artifact.
// KVM tests use it only to compare post-restore kernel randomness.
func diagnosticRandom() (string, error) {
	value := make([]byte, 32)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return hex.EncodeToString(value), nil
}

func diagnosticWriteMarker(path, value string) error   { return os.WriteFile(path, []byte(value), 0o600) }
func diagnosticReadMarker(path string) ([]byte, error) { return os.ReadFile(path) }

func serveDiagnostics() error {
	return serveDiagnosticsWithControl(nil, nil)
}

func serveDiagnosticsWithControl(listenerReady chan<- error, continueBroker chan<- struct{}) error {
	if err := os.MkdirAll("/dev/shm", 0o700); err != nil {
		return err
	}
	if err := syscall.Mount("tmpfs", "/dev/shm", "tmpfs", 0, "mode=0700,size=1m"); err != nil {
		return err
	}
	fd, err := syscall.Socket(afVsock, syscall.SOCK_STREAM, 0)
	if err != nil {
		if listenerReady != nil {
			listenerReady <- err
		}
		return err
	}
	defer syscall.Close(fd)
	address := sockaddrVM{Family: afVsock, Port: diagnosticPort, CID: vmaddrCIDAny}
	_, _, errno := syscall.Syscall(syscall.SYS_BIND, uintptr(fd), uintptr(unsafe.Pointer(&address)), unsafe.Sizeof(address))
	if errno != 0 {
		if listenerReady != nil {
			listenerReady <- errno
		}
		return errno
	}
	if err := syscall.Listen(fd, 8); err != nil {
		if listenerReady != nil {
			listenerReady <- err
		}
		return err
	}
	if listenerReady != nil {
		listenerReady <- nil
	}
	for {
		connection, _, errno := syscall.Syscall(syscall.SYS_ACCEPT, uintptr(fd), 0, 0)
		if errno != 0 {
			return errno
		}
		go handleDiagnostic(int(connection), continueBroker)
	}
}

func handleDiagnostic(fd int, continueBroker chan<- struct{}) {
	defer syscall.Close(fd)
	reader := bufio.NewReader(os.NewFile(uintptr(fd), "diagnostic"))
	line, err := reader.ReadBytes('\n')
	if err != nil || len(line) > 4096 {
		return
	}
	var request diagnosticRequest
	if json.Unmarshal(line, &request) != nil {
		writeDiagnostic(fd, diagnosticResponse{Error: "invalid request"})
		return
	}
	if request.Operation == "continue_broker" && request.Path == "" && request.Value == "" && continueBroker != nil {
		select {
		case continueBroker <- struct{}{}:
			writeDiagnostic(fd, diagnosticResponse{Ok: true})
			return
		default:
			writeDiagnostic(fd, diagnosticResponse{Error: "broker already continued"})
			return
		}
	}
	if request.Operation == "random" && request.Path == "" && request.Value == "" {
		value, err := diagnosticRandom()
		if err == nil {
			writeDiagnostic(fd, diagnosticResponse{Ok: true, Value: value})
			return
		}
	}
	if request.Operation == "write_marker" && request.Path == "/dev/shm/caisson-marker" && len(request.Value) <= 256 {
		err := diagnosticWriteMarker(request.Path, request.Value)
		if err == nil {
			writeDiagnostic(fd, diagnosticResponse{Ok: true})
			return
		}
	}
	if request.Operation == "read_marker" && request.Path == "/dev/shm/caisson-marker" && request.Value == "" {
		value, err := diagnosticReadMarker(request.Path)
		if err == nil {
			writeDiagnostic(fd, diagnosticResponse{Ok: true, Value: string(value)})
			return
		}
		if os.IsNotExist(err) {
			writeDiagnostic(fd, diagnosticResponse{Ok: true})
			return
		}
	}
	if request.Operation == "scan_canary" && request.Path == "" && request.Value == "" {
		matches, err := diagnosticCanaryLocations()
		if err == nil {
			value, _ := json.Marshal(matches)
			writeDiagnostic(fd, diagnosticResponse{Ok: true, Value: string(value)})
			return
		}
	}
	if request.Operation == "network_probe" && request.Path == "" && (request.Value == "node" || request.Value == "python3") {
		value, err := diagnosticNetworkProbe(request.Value)
		if err == nil {
			writeDiagnostic(fd, diagnosticResponse{Ok: true, Value: value})
			return
		}
		// This diagnostic-only response contains only a local process status.
		// It is needed to distinguish an absent network route from a missing
		// runtime dependency during the KVM verification.
		writeDiagnostic(fd, diagnosticResponse{Error: fmt.Sprintf("network probe %s failed: %v", request.Value, err)})
		return
	}
	if request.Operation == "agent_tool" && request.Path == "" && len(request.Value) > 0 && len(request.Value) <= runtimeFrameMaxBytes {
		value, err := diagnosticAgentTool(request.Value)
		if err == nil {
			writeDiagnostic(fd, diagnosticResponse{Ok: true, Value: value})
			return
		}
		writeDiagnostic(fd, diagnosticResponse{Error: "agent tool diagnostic failed"})
		return
	}
	if request.Operation == "agent_socket_stat" && request.Path == "" && request.Value == "" {
		value, err := diagnosticAgentSocketState()
		if err == nil {
			writeDiagnostic(fd, diagnosticResponse{Ok: true, Value: value})
			return
		}
	}
	if request.Operation == "agent_fault" && request.Path == "" &&
		(request.Value == "abandon" || request.Value == "invalid_completion" || request.Value == "oversized") {
		value, err := diagnosticAgentFault(request.Value)
		if err == nil {
			writeDiagnostic(fd, diagnosticResponse{Ok: true, Value: value})
			return
		}
		writeDiagnostic(fd, diagnosticResponse{Error: "agent fault diagnostic failed"})
		return
	}
	writeDiagnostic(fd, diagnosticResponse{Error: "invalid request"})
}

// diagnosticNetworkProbe is test-only. It invokes the real packaged runtime
// without a shell and reports only whether a network connection succeeded.
func diagnosticNetworkProbe(runtime string) (string, error) {
	const nodeProgram = `const net=require("node:net");const s=net.connect({host:"1.1.1.1",port:443});s.on("connect",()=>process.exit(2));s.on("error",e=>{process.stderr.write(String(e&&e.code));process.exit(e&&e.code==="ENETUNREACH"?0:1)});s.setTimeout(1000,()=>{process.stderr.write("ETIMEDOUT");process.exit(1)});`
	const pythonProgram = `import socket,sys
s=socket.socket();s.settimeout(1)
try:
 s.connect(("1.1.1.1",443));sys.exit(2)
except OSError as e:
 print(e.errno, file=sys.stderr);sys.exit(0 if e.errno == 101 else 1)`
	path := "/usr/bin/node"
	argument := "--eval"
	program := nodeProgram
	if runtime == "python3" {
		path = "/usr/bin/python3"
		argument = "-c"
		program = pythonProgram
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, path, argument, program)
	command.Env = []string{"PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/tmp"}
	output, err := command.CombinedOutput()
	if err == nil {
		return "network-unreachable", nil
	}
	if ctx.Err() != nil {
		return "", fmt.Errorf("network probe timed out")
	}
	return "", fmt.Errorf("runtime did not receive ENETUNREACH: %w (%s)", err, strings.TrimSpace(string(output)))
}

// INV-1 uses a separately generated AWS-access-key-shaped canary. Scanning
// that bounded exact shape avoids applying a permissive JWT expression to the
// static Go binary, where ordinary build metadata creates false candidates.
var diagnosticCanaryCandidate = regexp.MustCompile(`AKIA[A-Z0-9]{16}`)

// diagnosticCanaryLocations inspects diagnostic-visible process and filesystem
// state for the known test canary. The host supplies only its SHA-256 digest in
// boot configuration, never the canary value. It returns locations, never
// matched values.
func diagnosticCanaryLocations() ([]string, error) {
	wanted, err := diagnosticCanaryHash()
	if err != nil {
		return nil, err
	}
	matches := make([]string, 0)
	inspect := func(location string, value []byte) {
		for _, candidate := range diagnosticCanaryCandidate.FindAll(value, -1) {
			digest := sha256.Sum256(candidate)
			if hex.EncodeToString(digest[:]) == wanted {
				matches = append(matches, location)
				return
			}
		}
	}
	inspect("environment", []byte(strings.Join(os.Environ(), "\n")))
	processes, err := os.ReadDir("/proc")
	if err != nil {
		return nil, err
	}
	for _, process := range processes {
		if !process.IsDir() || !isDecimal(process.Name()) {
			continue
		}
		for _, name := range []string{"environ", "cmdline"} {
			path := filepath.Join("/proc", process.Name(), name)
			if value, readErr := os.ReadFile(path); readErr == nil {
				inspect(path, value)
			}
		}
	}
	for _, root := range []string{"/init", "/dev", "/dev/shm"} {
		walkErr := filepath.Walk(root, func(path string, info os.FileInfo, walkErr error) error {
			if walkErr != nil || !info.Mode().IsRegular() || info.Size() > 4*1024*1024 {
				return nil
			}
			if value, readErr := os.ReadFile(path); readErr == nil {
				inspect(path, value)
			}
			return nil
		})
		if walkErr != nil && !os.IsNotExist(walkErr) {
			return nil, fmt.Errorf("scan %s: %w", root, walkErr)
		}
	}
	return matches, nil
}

func diagnosticCanaryHash() (string, error) {
	data, err := os.ReadFile("/proc/cmdline")
	if err != nil {
		return "", err
	}
	for _, field := range strings.Fields(string(data)) {
		if value, ok := strings.CutPrefix(field, "caisson.diagnostic_canary_sha256="); ok {
			if len(value) == 64 && regexp.MustCompile(`^[0-9a-f]{64}$`).MatchString(value) {
				return value, nil
			}
			break
		}
	}
	return "", fmt.Errorf("diagnostic canary digest missing or invalid")
}

func isDecimal(value string) bool {
	if value == "" {
		return false
	}
	for _, character := range value {
		if character < '0' || character > '9' {
			return false
		}
	}
	return true
}
func writeDiagnostic(fd int, response diagnosticResponse) {
	value, _ := json.Marshal(response)
	_, _ = syscall.Write(fd, append(value, '\n'))
}
