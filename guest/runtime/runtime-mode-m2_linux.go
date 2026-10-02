//go:build linux && !agent

package main

import "fmt"

const agentRuntimeBuild = false

func serveAgentSocket() error { return nil }

func diagnosticAgentTool(_ string) (string, error) {
	return "", fmt.Errorf("agent runtime diagnostics are unavailable")
}

func diagnosticAgentSocketState() (string, error) {
	return "", fmt.Errorf("agent runtime diagnostics are unavailable")
}

func diagnosticAgentFault(_ string) (string, error) {
	return "", fmt.Errorf("agent runtime diagnostics are unavailable")
}

func setDiagnosticAgentSocketFailure(_ error) {}
