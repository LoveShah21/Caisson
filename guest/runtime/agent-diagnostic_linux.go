//go:build linux && agent && diagnostic

package main

import (
	"fmt"
	"net"
	"os"
	"syscall"
	"time"
)

// diagnosticAgentTool is test-only. It reaches the production socket server
// through its local transport, without adding any capability to the shipped
// agent runtime image.
func diagnosticAgentTool(request string) (string, error) {
	connection, err := net.DialTimeout("unix", agentSocketPath, 5*time.Second)
	if err != nil {
		return "", err
	}
	defer connection.Close()
	if err := connection.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
		return "", err
	}
	if err := writeFrame(connection, []byte(request)); err != nil {
		return "", err
	}
	response, err := readFrame(connection)
	if err != nil {
		return "", err
	}
	return string(response), nil
}

// diagnosticAgentSocketState proves the production runtime created an
// owner-only endpoint for the dedicated agent account without exposing a
// filesystem-inspection operation in the shipped image.
func diagnosticAgentSocketState() (string, error) {
	info, err := os.Lstat(agentSocketPath)
	if err != nil {
		return "", err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return "", fmt.Errorf("agent socket has no Linux stat data")
	}
	return fmt.Sprintf("%04o:%d:%d", info.Mode().Perm(), stat.Uid, stat.Gid), nil
}
