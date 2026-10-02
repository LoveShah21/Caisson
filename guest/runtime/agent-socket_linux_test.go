//go:build linux && agent

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRunAllowedRejectsDisallowedBinaryAndGitSubcommand(t *testing.T) {
	withTestExecutables(t, map[string]string{"cat": "/bin/echo", "git": "/bin/echo"})
	if _, _, _, _, _, err := runAllowed("sh", []string{"-c", "id"}, "/tmp", 1_000); err == nil {
		t.Fatal("shell was accepted")
	}
	if _, _, _, _, _, err := runAllowed("git", []string{"push"}, "/tmp", 1_000); err == nil {
		t.Fatal("git push was accepted")
	}
	if _, _, _, _, _, err := runAllowed("/workspace/uploaded", nil, "/tmp", 1_000); err == nil {
		t.Fatal("workspace executable was accepted")
	}
}

func TestRunAllowedUsesArgvWithoutShell(t *testing.T) {
	withTestExecutables(t, map[string]string{"cat": "/bin/echo"})
	marker := filepath.Join(t.TempDir(), "must-not-exist")
	stdout, _, code, _, _, err := runAllowed("cat", []string{";touch", marker}, "/tmp", 1_000)
	if err != nil || code != 0 {
		t.Fatalf("allowlisted argv failed: %v (%d)", err, code)
	}
	if !strings.Contains(stdout, ";touch") {
		t.Fatalf("argv was not passed literally: %q", stdout)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("shell metacharacter created a marker")
	}
}

func TestRunAllowedPinsExecutableAndSanitizesEnvironment(t *testing.T) {
	withTestExecutables(t, map[string]string{"cat": "/usr/bin/env"})
	stdout, _, code, _, _, err := runAllowed("cat", nil, "/tmp", 1_000)
	if err != nil || code != 0 {
		t.Fatalf("allowlisted env invocation failed: %v (%d)", err, code)
	}
	if strings.Contains(stdout, "LD_PRELOAD=") || strings.Contains(stdout, "LD_LIBRARY_PATH=") ||
		strings.Contains(stdout, "NODE_OPTIONS=") || strings.Contains(stdout, "PYTHONSTARTUP=") {
		t.Fatalf("child inherited unsafe environment: %q", stdout)
	}
	if !strings.Contains(stdout, "PATH=/usr/local/bin:/usr/bin:/bin") {
		t.Fatalf("child did not receive fixed PATH: %q", stdout)
	}

	directory := t.TempDir()
	link := filepath.Join(directory, "cat")
	if err := os.Symlink("/usr/bin/env", link); err != nil {
		t.Fatal(err)
	}
	executablePaths["cat"] = link
	if err := captureExecutableInodes(); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(link); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/bin/echo", link); err != nil {
		t.Fatal(err)
	}
	if _, _, _, _, _, err := runAllowed("cat", nil, "/tmp", 1_000); err == nil {
		t.Fatal("replaced allowlist symlink was accepted")
	}
}

func withTestExecutables(t *testing.T, paths map[string]string) {
	t.Helper()
	originalPaths := executablePaths
	originalInodes := executableInodes
	executablePaths = paths
	if err := captureExecutableInodes(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		executablePaths = originalPaths
		executableInodes = originalInodes
	})
}
