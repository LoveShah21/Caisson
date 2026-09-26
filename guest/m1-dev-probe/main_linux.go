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
	"unsafe"
)

const CAISSON_INFRA_PROBE_PORT = 9999
const afVsock = 40
const vmaddrCIDAny = 0xffffffff

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
		fmt.Fprintln(os.Stderr, "m1 development probe failed to listen")
		os.Exit(1)
	}
	defer syscall.Close(listener)

	for {
		connection, _, err := syscall.Accept(listener)
		if err != nil {
			continue
		}
		handle(connection)
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
		return
	}
	decoder := json.NewDecoder(bytes.NewReader(line))
	decoder.DisallowUnknownFields()
	var input request
	if decoder.Decode(&input) != nil || len(input.Argv) == 0 || input.Argv[0] == "" {
		writeResponse(fd, response{ExitCode: 2, Stderr: "invalid request"})
		return
	}

	command := exec.Command(input.Argv[0], input.Argv[1:]...)
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	err = command.Run()
	result := response{ExitCode: 0, Stdout: stdout.String(), Stderr: stderr.String()}
	if err != nil {
		result.ExitCode = 1
		if exitError, ok := err.(*exec.ExitError); ok {
			result.ExitCode = exitError.ExitCode()
		}
	}
	writeResponse(fd, result)
}

func writeResponse(fd int, value response) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return
	}
	_, _ = syscall.Write(fd, append(encoded, '\n'))
}
