//go:build linux && agent

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

const agentSocketPath = "/run/caisson/agent.sock"
const localToolPort = 1027
const agentUID = 65532
const agentGID = 65532
const workspaceRoot = "/workspace"
const noFollow = 0x20000

var executablePaths = map[string]string{
	"rg":      "/usr/bin/rg",
	"jq":      "/usr/bin/jq",
	"git":     "/usr/bin/git",
	"node":    "/usr/bin/node",
	"python3": "/usr/bin/python3",
	"cat":     "/usr/local/bin/cat",
	"ls":      "/usr/local/bin/ls",
	"head":    "/usr/local/bin/head",
	"tail":    "/usr/local/bin/tail",
	"wc":      "/usr/local/bin/wc",
	"sort":    "/usr/local/bin/sort",
	"uniq":    "/usr/local/bin/uniq",
	"diff":    "/usr/local/bin/diff",
}

var executableInodes map[string]uint64

type localToolRequest struct {
	ID   string          `json:"id"`
	Op   string          `json:"op"`
	Body json.RawMessage `json:"body"`
}

type brokerToolRequest struct {
	ID string `json:"id"`
	Op string `json:"op"`
}

type hostAuthorization struct {
	ID   string `json:"id"`
	OK   bool   `json:"ok"`
	Body struct {
		ActionID   string `json:"actionId"`
		Authorized bool   `json:"authorized"`
	} `json:"body"`
}

type completedSuccess struct {
	ID   string `json:"id"`
	Op   string `json:"op"`
	Body struct {
		ActionID string `json:"actionId"`
		Outcome  string `json:"outcome"`
		Result   any    `json:"result"`
	} `json:"body"`
}

type completedFailure struct {
	ID   string `json:"id"`
	Op   string `json:"op"`
	Body struct {
		ActionID string `json:"actionId"`
		Outcome  string `json:"outcome"`
		Error    struct {
			Code    string         `json:"code"`
			Message string         `json:"message"`
			Details map[string]any `json:"details"`
		} `json:"error"`
	} `json:"body"`
}

func serveAgentSocket() error {
	if err := os.Chown(workspaceRoot, agentUID, agentGID); err != nil {
		return err
	}
	if err := os.Chmod(workspaceRoot, 0o700); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(agentSocketPath), 0o755); err != nil {
		return err
	}
	if err := os.Remove(agentSocketPath); err != nil && !os.IsNotExist(err) {
		return err
	}
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: agentSocketPath, Net: "unix"})
	if err != nil {
		return err
	}
	defer listener.Close()
	defer os.Remove(agentSocketPath)
	if err := os.Chown(agentSocketPath, agentUID, agentGID); err != nil {
		return err
	}
	if err := os.Chmod(agentSocketPath, 0o600); err != nil {
		return err
	}
	if err := captureExecutableInodes(); err != nil {
		return err
	}
	for {
		connection, err := listener.AcceptUnix()
		if err != nil {
			return err
		}
		go func() {
			defer connection.Close()
			if err := handleAgentConnection(connection); err != nil {
				fmt.Fprintln(os.Stderr, "caisson runtime: local tool connection failed")
			}
		}()
	}
}

func handleAgentConnection(agent net.Conn) error {
	requestFrame, err := readFrame(agent)
	if err != nil {
		return err
	}
	request, err := parseLocalRequest(requestFrame)
	if err != nil {
		return handleBrokerRequest(agent, requestFrame)
	}
	host, err := connectHostLocalTools()
	if err != nil {
		return writeLocalError(agent, request.ID, "SANDBOX_FAILED", "broker transport unavailable")
	}
	defer host.Close()
	if err := writeFrame(host, requestFrame); err != nil {
		return err
	}
	authorizationFrame, err := readFrame(host)
	if err != nil {
		return err
	}
	var authorization hostAuthorization
	if err := json.Unmarshal(authorizationFrame, &authorization); err != nil {
		return err
	}
	if !authorization.OK || authorization.ID != request.ID {
		return writeFrame(agent, authorizationFrame)
	}
	if !authorization.Body.Authorized || authorization.Body.ActionID == "" {
		return writeLocalError(agent, request.ID, "PARAMS_INVALID", "invalid host authorization")
	}
	result, executionError := executeLocalTool(request)
	completion, err := makeCompletion(request.ID, authorization.Body.ActionID, result, executionError)
	if err != nil {
		return err
	}
	completionFrame, err := json.Marshal(completion)
	if err != nil {
		return err
	}
	if err := writeFrame(host, completionFrame); err != nil {
		return err
	}
	finalFrame, err := readFrame(host)
	if err != nil {
		return err
	}
	if !responseMatchesRequest(finalFrame, request.ID) {
		return writeLocalError(agent, request.ID, "PARAMS_INVALID", "invalid local tool response")
	}
	return writeFrame(agent, finalFrame)
}

// broker.call is the pre-existing seventh operation. It remains a single-frame
// exchange and is relayed without any guest-side service credential handling.
func handleBrokerRequest(agent net.Conn, frame []byte) error {
	var request brokerToolRequest
	if err := json.Unmarshal(frame, &request); err != nil || request.ID == "" || len([]byte(request.ID)) > 128 || request.Op != "broker.call" {
		return writeLocalError(agent, "unknown", "PARAMS_INVALID", "invalid guest operation")
	}
	host, err := connectHostBroker()
	if err != nil {
		return writeLocalError(agent, request.ID, "SANDBOX_FAILED", "broker transport unavailable")
	}
	defer host.Close()
	if err := writeFrame(host, frame); err != nil {
		return err
	}
	response, err := readFrame(host)
	if err != nil {
		return err
	}
	if !responseMatchesRequest(response, request.ID) {
		return writeLocalError(agent, request.ID, "PARAMS_INVALID", "invalid broker response")
	}
	return writeFrame(agent, response)
}

func connectHostLocalTools() (*os.File, error) {
	return connectHostPort(localToolPort)
}

func connectHostBroker() (*os.File, error) {
	return connectHostPort(brokerPort)
}

func connectHostPort(port uint32) (*os.File, error) {
	fd, err := syscall.Socket(afVsock, syscall.SOCK_STREAM, 0)
	if err != nil {
		return nil, err
	}
	address := sockaddrVM{Family: afVsock, Port: port, CID: hostCID}
	_, _, errno := syscall.Syscall(syscall.SYS_CONNECT, uintptr(fd), uintptr(unsafe.Pointer(&address)), unsafe.Sizeof(address))
	if errno != 0 {
		syscall.Close(fd)
		return nil, errno
	}
	return os.NewFile(uintptr(fd), "broker"), nil
}

func readFrame(reader io.Reader) ([]byte, error) {
	header := make([]byte, 4)
	if _, err := io.ReadFull(reader, header); err != nil {
		return nil, err
	}
	length := int(header[0])<<24 | int(header[1])<<16 | int(header[2])<<8 | int(header[3])
	if length < 0 || length > runtimeFrameMaxBytes {
		return nil, fmt.Errorf("invalid frame length")
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(reader, payload); err != nil {
		return nil, err
	}
	return payload, nil
}

func writeFrame(writer io.Writer, payload []byte) error {
	if len(payload) > runtimeFrameMaxBytes {
		return fmt.Errorf("frame exceeds limit")
	}
	header := []byte{byte(len(payload) >> 24), byte(len(payload) >> 16), byte(len(payload) >> 8), byte(len(payload))}
	if _, err := writer.Write(header); err != nil {
		return err
	}
	_, err := writer.Write(payload)
	return err
}

func parseLocalRequest(frame []byte) (localToolRequest, error) {
	var request localToolRequest
	if err := json.Unmarshal(frame, &request); err != nil {
		return request, err
	}
	if request.ID == "" || len([]byte(request.ID)) > 128 || len(request.Body) == 0 {
		return request, fmt.Errorf("invalid local request")
	}
	switch request.Op {
	case "fs.read", "fs.write", "fs.edit", "fs.search", "proc.exec", "user.ask":
		return request, nil
	default:
		return request, fmt.Errorf("unknown local operation")
	}
}

func makeCompletion(id, actionID string, result any, executionError *localExecutionError) (any, error) {
	if executionError == nil {
		completion := completedSuccess{ID: id, Op: "local.completed"}
		completion.Body.ActionID = actionID
		completion.Body.Outcome = "success"
		completion.Body.Result = result
		return completion, nil
	}
	completion := completedFailure{ID: id, Op: "local.completed"}
	completion.Body.ActionID = actionID
	completion.Body.Outcome = "failure"
	completion.Body.Error.Code = executionError.code
	completion.Body.Error.Message = executionError.message
	completion.Body.Error.Details = map[string]any{}
	return completion, nil
}

func responseMatchesRequest(frame []byte, id string) bool {
	var response struct {
		ID string `json:"id"`
	}
	return json.Unmarshal(frame, &response) == nil && response.ID == id
}

func writeLocalError(writer io.Writer, id, code, message string) error {
	payload, err := json.Marshal(map[string]any{
		"id":    id,
		"ok":    false,
		"error": map[string]any{"code": code, "message": message, "details": map[string]any{}},
	})
	if err != nil {
		return err
	}
	return writeFrame(writer, payload)
}

type localExecutionError struct {
	code    string
	message string
}

func executeLocalTool(request localToolRequest) (any, *localExecutionError) {
	switch request.Op {
	case "fs.read":
		return executeRead(request.Body)
	case "fs.write":
		return executeWrite(request.Body)
	case "fs.edit":
		return executeEdit(request.Body)
	case "fs.search":
		return executeSearch(request.Body)
	case "proc.exec":
		return executeProcess(request.Body)
	case "user.ask":
		return nil, &localExecutionError{code: "APPROVAL_UNAVAILABLE", message: "approval websocket authentication is not implemented until M-4"}
	default:
		return nil, &localExecutionError{code: "PARAMS_INVALID", message: "unknown local tool operation"}
	}
}

type readBody struct {
	Path  string `json:"path"`
	Range *struct {
		Start int `json:"start"`
		End   int `json:"end"`
	} `json:"range"`
}

func executeRead(raw json.RawMessage) (any, *localExecutionError) {
	var body readBody
	if err := json.Unmarshal(raw, &body); err != nil {
		return nil, invalidParams()
	}
	file, err := openWorkspaceFile(body.Path, syscall.O_RDONLY, 0)
	if err != nil {
		return nil, pathDenied()
	}
	defer file.Close()
	contents, err := io.ReadAll(io.LimitReader(file, 2*1024*1024+1))
	if err != nil || len(contents) > 2*1024*1024 {
		return nil, &localExecutionError{code: "PARAMS_INVALID", message: "workspace read exceeds size cap"}
	}
	start, end := 0, len(contents)
	if body.Range != nil {
		if body.Range.Start < 0 || body.Range.End <= body.Range.Start || body.Range.End > len(contents) {
			return nil, invalidParams()
		}
		start, end = body.Range.Start, body.Range.End
	}
	return map[string]any{"content": string(contents[start:end]), "bytes": end - start}, nil
}

type writeBody struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

func executeWrite(raw json.RawMessage) (any, *localExecutionError) {
	var body writeBody
	if err := json.Unmarshal(raw, &body); err != nil || len([]byte(body.Content)) > 2*1024*1024 {
		return nil, invalidParams()
	}
	file, err := openWorkspaceFile(body.Path, syscall.O_WRONLY|syscall.O_CREAT|syscall.O_TRUNC, 0o600)
	if err != nil {
		return nil, pathDenied()
	}
	defer file.Close()
	if err := file.Chown(agentUID, agentGID); err != nil {
		return nil, &localExecutionError{code: "SANDBOX_FAILED", message: "workspace ownership update failed"}
	}
	if _, err := file.WriteString(body.Content); err != nil {
		return nil, &localExecutionError{code: "SANDBOX_FAILED", message: "workspace write failed"}
	}
	return map[string]any{"bytes": len([]byte(body.Content))}, nil
}

type editBody struct {
	Path      string `json:"path"`
	OldString string `json:"oldString"`
	NewString string `json:"newString"`
}

func executeEdit(raw json.RawMessage) (any, *localExecutionError) {
	var body editBody
	if err := json.Unmarshal(raw, &body); err != nil || body.OldString == "" || len([]byte(body.NewString)) > 2*1024*1024 {
		return nil, invalidParams()
	}
	file, err := openWorkspaceFile(body.Path, syscall.O_RDONLY, 0)
	if err != nil {
		return nil, pathDenied()
	}
	contents, err := io.ReadAll(io.LimitReader(file, 2*1024*1024+1))
	file.Close()
	if err != nil || len(contents) > 2*1024*1024 {
		return nil, &localExecutionError{code: "PARAMS_INVALID", message: "workspace edit exceeds size cap"}
	}
	if bytes.Count(contents, []byte(body.OldString)) != 1 {
		return nil, &localExecutionError{code: "PARAMS_INVALID", message: "edit source must match exactly once"}
	}
	updated := strings.Replace(string(contents), body.OldString, body.NewString, 1)
	return executeWrite(mustJSON(writeBody{Path: body.Path, Content: updated}))
}

type searchBody struct {
	Pattern string `json:"pattern"`
	Path    string `json:"path"`
	Opts    struct {
		FixedStrings  bool `json:"fixedStrings"`
		CaseSensitive bool `json:"caseSensitive"`
	} `json:"opts"`
}

func executeSearch(raw json.RawMessage) (any, *localExecutionError) {
	var body searchBody
	if err := json.Unmarshal(raw, &body); err != nil || body.Pattern == "" {
		return nil, invalidParams()
	}
	target := workspaceRoot
	if body.Path != "" {
		resolved, err := workspaceRelativePath(body.Path)
		if err != nil {
			return nil, pathDenied()
		}
		target = filepath.Join(workspaceRoot, resolved)
	}
	args := []string{"--no-follow", "--line-number", "--no-heading"}
	if body.Opts.FixedStrings {
		args = append(args, "--fixed-strings")
	}
	if body.Opts.CaseSensitive {
		args = append(args, "--case-sensitive")
	}
	args = append(args, "--", body.Pattern, target)
	stdout, stderr, code, timedOut, outputTruncated, err := runAllowed("rg", args, workspaceRoot, 30_000)
	if timedOut {
		return nil, &localExecutionError{code: "SERVICE_TIMEOUT", message: "search timed out"}
	}
	if err != nil && code != 1 {
		return nil, &localExecutionError{code: "SERVICE_ERROR", message: "search failed"}
	}
	return map[string]any{"matches": stdout, "stderr": stderr, "exitCode": code, "truncated": outputTruncated}, nil
}

type execBody struct {
	Argv      []string `json:"argv"`
	Cwd       string   `json:"cwd"`
	TimeoutMS int      `json:"timeoutMs"`
}

func executeProcess(raw json.RawMessage) (any, *localExecutionError) {
	var body execBody
	if err := json.Unmarshal(raw, &body); err != nil || len(body.Argv) == 0 || len(body.Argv) > 128 {
		return nil, invalidParams()
	}
	for _, value := range body.Argv {
		if value == "" || len(value) > 8192 {
			return nil, invalidParams()
		}
	}
	cwd := workspaceRoot
	if body.Cwd != "" {
		relative, err := workspaceRelativePath(body.Cwd)
		if err != nil {
			return nil, pathDenied()
		}
		cwd = filepath.Join(workspaceRoot, relative)
	}
	timeout := body.TimeoutMS
	if timeout == 0 {
		timeout = 30_000
	}
	if timeout < 1 || timeout > 300_000 {
		return nil, invalidParams()
	}
	stdout, stderr, code, timedOut, outputTruncated, err := runAllowed(body.Argv[0], body.Argv[1:], cwd, timeout)
	if timedOut {
		return nil, &localExecutionError{code: "SERVICE_TIMEOUT", message: "process timed out"}
	}
	if err != nil && code < 0 {
		return nil, &localExecutionError{code: "SERVICE_ERROR", message: "process could not start"}
	}
	return map[string]any{"stdout": stdout, "stderr": stderr, "exitCode": code, "truncated": outputTruncated}, nil
}

func runAllowed(command string, args []string, cwd string, timeoutMS int) (string, string, int, bool, bool, error) {
	path, allowed := executablePaths[command]
	if !allowed || strings.Contains(command, "/") || (command == "git" && !allowedGit(args)) {
		return "", "", -1, false, false, fmt.Errorf("binary not allowed")
	}
	info, err := os.Stat(path)
	if err != nil || executableInodes[path] == 0 || inode(info) != executableInodes[path] {
		return "", "", -1, false, false, fmt.Errorf("allowlisted binary changed")
	}
	executionContext, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutMS)*time.Millisecond)
	defer cancel()
	commandProcess := exec.CommandContext(executionContext, path, args...)
	commandProcess.Dir = cwd
	commandProcess.Env = []string{"PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/workspace", "LANG=C.UTF-8"}
	commandProcess.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: agentUID, Gid: agentGID}}
	stdout := cappedBuffer{limit: 2 * 1024 * 1024}
	stderr := cappedBuffer{limit: 2 * 1024 * 1024}
	commandProcess.Stdout = &stdout
	commandProcess.Stderr = &stderr
	err = commandProcess.Run()
	if executionContext.Err() == context.DeadlineExceeded {
		return stdout.String(), stderr.String(), -1, true, stdout.truncated || stderr.truncated, err
	}
	if err == nil {
		return stdout.String(), stderr.String(), 0, false, stdout.truncated || stderr.truncated, nil
	}
	if exit, ok := err.(*exec.ExitError); ok {
		return stdout.String(), stderr.String(), exit.ExitCode(), false, stdout.truncated || stderr.truncated, err
	}
	return stdout.String(), stderr.String(), -1, false, stdout.truncated || stderr.truncated, err
}

// Capping guest process output prevents a local operation from consuming the
// runtime's memory before the host applies its independent result cap.
type cappedBuffer struct {
	bytes.Buffer
	limit     int
	truncated bool
}

func (buffer *cappedBuffer) Write(input []byte) (int, error) {
	remaining := buffer.limit - buffer.Len()
	if remaining <= 0 {
		buffer.truncated = true
		return len(input), nil
	}
	if len(input) > remaining {
		_, _ = buffer.Buffer.Write(input[:remaining])
		buffer.truncated = true
		return len(input), nil
	}
	return buffer.Buffer.Write(input)
}

func captureExecutableInodes() error {
	executableInodes = make(map[string]uint64, len(executablePaths))
	for _, path := range executablePaths {
		info, err := os.Stat(path)
		if err != nil {
			return err
		}
		executableInodes[path] = inode(info)
	}
	return nil
}

func inode(info os.FileInfo) uint64 {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return 0
	}
	return stat.Ino
}

func allowedGit(args []string) bool {
	if len(args) == 0 {
		return false
	}
	switch args[0] {
	case "fetch", "clone", "log", "diff", "status":
		return true
	default:
		return false
	}
}

func openWorkspaceFile(path string, flags, mode int) (*os.File, error) {
	relative, err := workspaceRelativePath(path)
	if err != nil || relative == "." {
		return nil, fmt.Errorf("invalid workspace path")
	}
	parts := strings.Split(relative, string(os.PathSeparator))
	directory, err := syscall.Open(workspaceRoot, syscall.O_RDONLY|syscall.O_DIRECTORY|noFollow, 0)
	if err != nil {
		return nil, err
	}
	defer syscall.Close(directory)
	for _, part := range parts[:len(parts)-1] {
		next, err := syscall.Openat(directory, part, syscall.O_RDONLY|syscall.O_DIRECTORY|noFollow, 0)
		if err != nil {
			return nil, err
		}
		syscall.Close(directory)
		directory = next
	}
	fd, err := syscall.Openat(directory, parts[len(parts)-1], flags|noFollow, uint32(mode))
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(fd), "workspace"), nil
}

func workspaceRelativePath(path string) (string, error) {
	if path == "" || !filepath.IsAbs(path) {
		return "", fmt.Errorf("workspace path must be absolute")
	}
	clean := filepath.Clean(path)
	relative, err := filepath.Rel(workspaceRoot, clean)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(os.PathSeparator)) {
		return "", fmt.Errorf("workspace path denied")
	}
	return relative, nil
}

func invalidParams() *localExecutionError {
	return &localExecutionError{code: "PARAMS_INVALID", message: "invalid local tool parameters"}
}

func pathDenied() *localExecutionError {
	return &localExecutionError{code: "PATH_DENIED", message: "path is outside the workspace or follows a symlink"}
}

func mustJSON(value any) json.RawMessage {
	encoded, _ := json.Marshal(value)
	return encoded
}
