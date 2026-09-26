package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Println(join(os.Args[1:]))
}

func join(values []string) string {
	if len(values) == 0 {
		return ""
	}
	result := values[0]
	for _, value := range values[1:] {
		result += " " + value
	}
	return result
}
