//go:build linux && agent && diagnostic

package main

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"strings"
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

// diagnosticAgentFault exercises only the host-side local-tool state machine.
// It is compiled exclusively into the ineligible diagnostic rootfs. Production
// agents always use the socket client, which creates a well-formed completion.
func diagnosticAgentFault(kind string) (string, error) {
	connection, err := connectHostLocalTools()
	if err != nil {
		return "", err
	}
	defer connection.Close()
	request := []byte(`{"id":"diagnostic-local-fault","op":"fs.read","body":{"path":"/workspace/missing.txt"}}`)
	if err := writeFrame(connection, request); err != nil {
		return "", err
	}
	authorizationFrame, err := readFrame(connection)
	if err != nil {
		return "", err
	}
	var authorization hostAuthorization
	if err := json.Unmarshal(authorizationFrame, &authorization); err != nil || !authorization.OK || !authorization.Body.Authorized {
		return "", fmt.Errorf("invalid local authorization")
	}
	if kind == "abandon" {
		// Keep the real guest stream open past the configured host completion
		// deadline. This proves the timeout branch rather than only the EOF
		// branch of action.abandoned.
		time.Sleep(250 * time.Millisecond)
		return "authorized", nil
	}
	completionID := authorization.ID
	if kind == "invalid_completion" {
		completionID = "mismatched-diagnostic-id"
	}
	result := any(map[string]any{"value": "ok"})
	if kind == "oversized" {
		result = map[string]any{"value": strings.Repeat("x", 4096)}
	}
	completion := completedSuccess{ID: completionID, Op: "local.completed"}
	completion.Body.ActionID = authorization.Body.ActionID
	completion.Body.Outcome = "success"
	completion.Body.Result = result
	payload, err := json.Marshal(completion)
	if err != nil {
		return "", err
	}
	if err := writeFrame(connection, payload); err != nil {
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
