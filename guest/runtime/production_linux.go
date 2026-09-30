//go:build linux && !diagnostic

package main

const diagnosticRuntimeBuild = false

func diagnosticRandom() (string, error)                { panic("diagnostics are unavailable") }
func diagnosticWriteMarker(path, value string) error   { panic("diagnostics are unavailable") }
func diagnosticReadMarker(path string) ([]byte, error) { panic("diagnostics are unavailable") }
func serveDiagnostics() error                          { return nil }
