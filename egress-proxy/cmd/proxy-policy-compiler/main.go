package main

import (
	"bufio"
	"errors"
	"flag"
	"fmt"
	"net"
	"os"
	"sort"
	"strconv"
	"strings"
)

const placeholder = "{{ALLOW_POLICIES}}"

func main() {
	outPath := flag.String("out", "envoy.yaml", "output envoy config path")
	flag.Parse()

	allowlistPath, err := selectAllowlistPath("/app/policy/allowlist.txt", "/app/policy/allowlist.default.txt")
	must(err)

	entries, err := readAllowlist(allowlistPath)
	must(err)

	tmpl, err := os.ReadFile("/app/policy/envoy.template.yaml")
	must(err)

	template := string(tmpl)
	output, err := renderTemplate(template, entries)
	must(err)
	must(os.WriteFile(*outPath, []byte(output), 0644))
}

func renderTemplate(template string, entries []string) (string, error) {
	placeholderStart := strings.Index(template, placeholder)
	if placeholderStart < 0 {
		return "", fmt.Errorf("template missing placeholder %s", placeholder)
	}
	if strings.Contains(template[placeholderStart+len(placeholder):], placeholder) {
		return "", fmt.Errorf("template must contain exactly one %s placeholder", placeholder)
	}

	lineStart := strings.LastIndex(template[:placeholderStart], "\n") + 1
	lineEnd := placeholderStart + len(placeholder)
	if nextNewline := strings.Index(template[lineEnd:], "\n"); nextNewline >= 0 {
		lineEnd += nextNewline + 1
	} else {
		lineEnd = len(template)
	}

	line := template[lineStart:lineEnd]
	lineWithoutNewline := strings.TrimSuffix(line, "\n")
	lineWithoutNewline = strings.TrimSuffix(lineWithoutNewline, "\r")
	placeholderOffset := strings.Index(lineWithoutNewline, placeholder)
	prefix := lineWithoutNewline[:placeholderOffset]
	suffix := lineWithoutNewline[placeholderOffset+len(placeholder):]
	if !isWhitespace(prefix) || !isWhitespace(suffix) {
		return "", fmt.Errorf("template placeholder line must contain only indentation and %s", placeholder)
	}

	rendered := renderPolicies(entries, prefix)
	if strings.HasSuffix(line, "\n") {
		rendered += "\n"
	}

	return template[:lineStart] + rendered + template[lineEnd:], nil
}

func isWhitespace(value string) bool {
	for _, r := range value {
		if r != ' ' && r != '\t' {
			return false
		}
	}
	return true
}

func selectAllowlistPath(customPath, defaultPath string) (string, error) {
	_, err := os.Stat(customPath)
	if err == nil {
		return customPath, nil
	}
	if errors.Is(err, os.ErrNotExist) {
		return defaultPath, nil
	}
	return "", err
}

func readAllowlist(path string) ([]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	seen := map[string]bool{}
	var entries []string

	scanner := bufio.NewScanner(f)
	lineNumber := 0
	for scanner.Scan() {
		lineNumber++
		line := strings.TrimSpace(scanner.Text())

		if i := strings.Index(line, "#"); i >= 0 {
			line = strings.TrimSpace(line[:i])
		}
		if line == "" {
			continue
		}

		entry, err := normalizeAllowlistEntry(line)
		if err != nil {
			return nil, fmt.Errorf("%s:%d: %w", path, lineNumber, err)
		}

		if !seen[entry] {
			seen[entry] = true
			entries = append(entries, entry)
		}
	}

	if err := scanner.Err(); err != nil {
		return nil, err
	}

	sort.Strings(entries)
	return entries, nil
}

func normalizeAllowlistEntry(entry string) (string, error) {
	if strings.Contains(entry, "://") || strings.Contains(entry, "/") {
		return "", fmt.Errorf("invalid allowlist entry %q: use exact host:port only", entry)
	}

	host, port, err := net.SplitHostPort(entry)
	if err != nil {
		return "", fmt.Errorf("invalid allowlist entry %q: expected host:port", entry)
	}
	if host == "" {
		return "", fmt.Errorf("invalid allowlist entry %q: host is required", entry)
	}
	if err := validatePort(port); err != nil {
		return "", fmt.Errorf("invalid allowlist entry %q: %w", entry, err)
	}

	host = strings.ToLower(strings.Trim(host, "[]"))
	if err := validateHost(host); err != nil {
		return "", fmt.Errorf("invalid allowlist entry %q: %w", entry, err)
	}

	return net.JoinHostPort(host, port), nil
}

func validatePort(port string) error {
	value, err := strconv.Atoi(port)
	if err != nil || value < 1 || value > 65535 {
		return fmt.Errorf("port must be an integer from 1 to 65535")
	}
	return nil
}

func validateHost(host string) error {
	if ip := net.ParseIP(host); ip != nil {
		return nil
	}
	if len(host) > 253 {
		return fmt.Errorf("host is too long")
	}
	if strings.HasPrefix(host, ".") || strings.HasSuffix(host, ".") || strings.Contains(host, "..") {
		return fmt.Errorf("host must be a DNS name without leading, trailing, or repeated dots")
	}

	for _, label := range strings.Split(host, ".") {
		if len(label) == 0 || len(label) > 63 {
			return fmt.Errorf("host contains an invalid DNS label")
		}
		if label[0] == '-' || label[len(label)-1] == '-' {
			return fmt.Errorf("DNS labels must not start or end with '-'")
		}
		for _, r := range label {
			if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' {
				continue
			}
			return fmt.Errorf("host contains invalid character %q", r)
		}
	}

	return nil
}

func renderPolicies(entries []string, indent string) string {
	rendered := map[string]bool{}
	var b strings.Builder

	for _, entry := range entries {
		renderPolicyOnce(&b, rendered, entry, indent)

		host, port, err := net.SplitHostPort(entry)
		must(err)
		if port == "80" || port == "443" {
			renderPolicyOnce(&b, rendered, host, indent)
		}
	}

	return strings.TrimRight(b.String(), "\n")
}

func renderPolicyOnce(b *strings.Builder, rendered map[string]bool, entry string, indent string) {
	if rendered[entry] {
		return
	}
	rendered[entry] = true
	renderPolicy(b, entry, indent)
}

func renderPolicy(b *strings.Builder, entry string, indent string) {
	fmt.Fprintf(b, `%s- header:
%s    name: ":authority"
%s    string_match:
%s      exact: "%s"
%s- header:
%s    name: "host"
%s    string_match:
%s      exact: "%s"
`, indent, indent, indent, indent, entry, indent, indent, indent, indent, entry)
}

func must(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}
