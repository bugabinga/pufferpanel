package services

import (
	"net"
	"net/netip"
	"net/url"
	"testing"
)

func TestNodeHostPort(t *testing.T) {
	tests := []struct {
		name string
		host string
		port uint16
		want string
	}{
		{name: "hostname", host: "node.example.test", port: 8080, want: "node.example.test:8080"},
		{name: "ipv4", host: "192.168.1.10", port: 8080, want: "192.168.1.10:8080"},
		{name: "ipv6 literal", host: "fc00::1", port: 5656, want: "[fc00::1]:5656"},
		{name: "ipv6 full", host: "2001:db8:85a3:8d3:1319:8a2e:370:7348", port: 8080, want: "[2001:db8:85a3:8d3:1319:8a2e:370:7348]:8080"},
		{name: "bracketed ipv6 workaround", host: "[fc00::1]", port: 5656, want: "[fc00::1]:5656"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := nodeHostPort(tt.host, tt.port)
			if got != tt.want {
				t.Errorf("nodeHostPort() = %q, want %q", got, tt.want)
			}

			// the rendered address must survive the exact parsing a dial performs,
			// which the old fmt.Sprintf("%s:%d", ...) form failed for IPv6 hosts
			host, port, err := net.SplitHostPort(got)
			if err != nil {
				t.Fatalf("nodeHostPort() result %q is not a dialable address: %v", got, err)
			}
			if port != "5656" && port != "8080" {
				t.Errorf("nodeHostPort() port = %q, want the input port as a string", port)
			}
			if host == "" {
				t.Errorf("nodeHostPort() lost the host in %q", got)
			}

			// IP hosts must round-trip through the address parser without brackets
			unbracketed := tt.host
			if len(unbracketed) > 1 && unbracketed[0] == '[' && unbracketed[len(unbracketed)-1] == ']' {
				unbracketed = unbracketed[1 : len(unbracketed)-1]
			}
			if addr, err := netip.ParseAddr(unbracketed); err == nil {
				parsed, err := netip.ParseAddr(host)
				if err != nil {
					t.Fatalf("nodeHostPort() host %q is not a valid address: %v", host, err)
				}
				if parsed != addr {
					t.Errorf("nodeHostPort() host = %q, want %q", host, addr)
				}
			}
		})
	}
}

// regression for upstream issue #1478: the websocket proxy URL built for a node
// must parse cleanly when the node host is a bare IPv6 literal, because the
// websocket dialer and net/http both parse it as a URL before dialing
func TestNodeHostPortInURL(t *testing.T) {
	tests := []struct {
		name   string
		scheme string
		host   string
		port   uint16
	}{
		{name: "ws ipv6 literal", scheme: "ws", host: "fc00::1", port: 5656},
		{name: "wss ipv6 literal", scheme: "wss", host: "2001:db8::1", port: 8080},
		{name: "ws hostname", scheme: "ws", host: "node.example.test", port: 5656},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			raw := tt.scheme + "://" + nodeHostPort(tt.host, tt.port) + "/daemon"
			u, err := url.Parse(raw)
			if err != nil {
				t.Fatalf("node URL %q does not parse: %v", raw, err)
			}
			wantPort := "5656"
			if tt.port == 8080 {
				wantPort = "8080"
			}
			if u.Hostname() != tt.host {
				t.Errorf("node URL %q hostname = %q, want %q", raw, u.Hostname(), tt.host)
			}
			if u.Port() != wantPort {
				t.Errorf("node URL %q port = %q, want %q", raw, u.Port(), wantPort)
			}
		})
	}
}
