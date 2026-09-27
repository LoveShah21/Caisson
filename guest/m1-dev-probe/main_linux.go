//go:build linux

package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"syscall"
	"time"
	"unsafe"
)

const CAISSON_INFRA_PROBE_PORT = 9999
const afVsock = 40
const vmaddrCIDAny = 0xffffffff
const acceptErrorBackoff = 50 * time.Millisecond

type sockaddrVM struct {
	Family   uint16
	Reserved uint16
	Port     uint32
	CID      uint32
	Zero     [4]byte
}

type request struct {
	Argv []string `json:"argv"`
}

type response struct {
	ExitCode int    `json:"exitCode"`
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
}

func main() {
	listener, err := listen()
	if err != nil {
		fmt.Fprintln(os.Stderr, "m1 development probe: listener bind failed")
		os.Exit(1)
	}
	defer syscall.Close(listener)
	fmt.Fprintln(os.Stderr, "m1 development probe: listener bound")

	for {
		connection, _, err := syscall.Accept(listener)
		if err != nil {
			fmt.Fprintf(os.Stderr, "m1 development probe: accept error: %v\n", err)
			time.Sleep(acceptErrorBackoff)
			continue
		}
		fmt.Fprintln(os.Stderr, "m1 development probe: connection accepted")
		// A closed or slow host probe must not prevent the listener from
		// accepting the next connection.
		go handle(connection)
	}
}

func listen() (int, error) {
	fd, err := syscall.Socket(afVsock, syscall.SOCK_STREAM, 0)
	if err != nil {
		return -1, err
	}
	address := sockaddrVM{Family: afVsock, Port: CAISSON_INFRA_PROBE_PORT, CID: vmaddrCIDAny}
	_, _, errno := syscall.Syscall(syscall.SYS_BIND, uintptr(fd), uintptr(unsafe.Pointer(&address)), unsafe.Sizeof(address))
	if errno != 0 {
		syscall.Close(fd)
		return -1, errno
	}
	if err := syscall.Listen(fd, 16); err != nil {
		syscall.Close(fd)
		return -1, err
	}
	return fd, nil
}

func handle(fd int) {
	connection := os.NewFile(uintptr(fd), "vsock")
	defer connection.Close()
	reader := bufio.NewReader(connection)
	line, err := reader.ReadBytes('\n')
	if err != nil {
		fmt.Fprintln(os.Stderr, "m1 development probe: request read failed")
		return
	}
	fmt.Fprintln(os.Stderr, "m1 development probe: request line read")
	decoder := json.NewDecoder(bytes.NewReader(line))
	decoder.DisallowUnknownFields()
	var input request
	if decoder.Decode(&input) != nil || len(input.Argv) == 0 || input.Argv[0] == "" {
		fmt.Fprintln(os.Stderr, "m1 development probe: request invalid")
		writeResponse(fd, response{ExitCode: 2, Stderr: "invalid request"})
		return
	}

	command := exec.Command(input.Argv[0], input.Argv[1:]...)
	// Do not let os/exec open /dev/null for an unset stdin. The M-1 probe
	// must work before the guest has mounted devtmpfs.
	command.Stdin = bytes.NewReader(nil)
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	fmt.Fprintln(os.Stderr, "m1 development probe: command starting")
	if err := command.Start(); err != nil {
		fmt.Fprintln(os.Stderr, "m1 development probe: command start failed")
		writeResponse(fd, response{ExitCode: 1, Stderr: "command failed"})
		return
	}
	fmt.Fprintln(os.Stderr, "m1 development probe: command started")
	err = command.Wait()
	result := response{ExitCode: 0, Stdout: stdout.String(), Stderr: stderr.String()}
	if err != nil {
		result.ExitCode = 1
		if exitError, ok := err.(*exec.ExitError); ok {
			result.ExitCode = exitError.ExitCode()
		} else if result.Stderr == "" {
			// Start failures, including a missing binary, still receive a framed
			// response. Do not expose host error text through this dev protocol.
			result.Stderr = "command failed"
		}
	}
	fmt.Fprintln(os.Stderr, "m1 development probe: command completed")
	writeResponse(fd, result)
}

func writeResponse(fd int, value response) {
	fmt.Fprintln(os.Stderr, "m1 development probe: response writing")
	encoded, err := json.Marshal(value)
	if err != nil {
		fmt.Fprintln(os.Stderr, "m1 development probe: response encoding failed")
		return
	}
	if _, err := syscall.Write(fd, append(encoded, '\n')); err != nil {
		fmt.Fprintln(os.Stderr, "m1 development probe: response write failed")
		return
	}
	fmt.Fprintln(os.Stderr, "m1 development probe: response written")
}
