package services

import (
	"net"
	"net/netip"
	"net/url"
	"testing"

	"github.com/pufferpanel/pufferpanel/v3/config"
	"github.com/pufferpanel/pufferpanel/v3/models"
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

// regression for the IPv6 half of upstream issue #1478: the master URL is a
// host:port string, and the old naive colon split turned bracketed IPv6
// literals into garbage hosts ("[fc00") while silently dropping the port
func TestSyncNodeToConfigMasterUrl(t *testing.T) {
	origMasterUrl := config.MasterUrl.Value()
	origSftpHost := config.SftpHost.Value()
	t.Cleanup(func() {
		if err := config.MasterUrl.Set(origMasterUrl, false); err != nil {
			t.Errorf("restore masterUrl: %v", err)
		}
		if err := config.SftpHost.Set(origSftpHost, false); err != nil {
			t.Errorf("restore sftp host: %v", err)
		}
		SyncNodeToConfig()
	})

	tests := []struct {
		name      string
		masterUrl string
		wantHost  string
		wantPort  uint16
	}{
		{name: "ipv4 host and port", masterUrl: "http://192.168.1.10:8080", wantHost: "192.168.1.10", wantPort: 8080},
		{name: "hostname with port", masterUrl: "http://panel.example.test:8080", wantHost: "panel.example.test", wantPort: 8080},
		{name: "hostname no port https", masterUrl: "https://panel.example.test", wantHost: "panel.example.test", wantPort: 443},
		{name: "hostname no port http", masterUrl: "http://panel.example.test", wantHost: "panel.example.test", wantPort: 80},
		{name: "bracketed ipv6 with port", masterUrl: "https://[fc00::10]:8443/", wantHost: "fc00::10", wantPort: 8443},
		{name: "bracketed ipv6 no port http", masterUrl: "http://[2001:db8::1]", wantHost: "2001:db8::1", wantPort: 80},
		{name: "bracketed ipv6 no port https", masterUrl: "https://[2001:db8::1]", wantHost: "2001:db8::1", wantPort: 443},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := config.MasterUrl.Set(tt.masterUrl, false); err != nil {
				t.Fatalf("set masterUrl: %v", err)
			}
			// sentinels so expected values cannot pass by coincidence of ordering
			models.LocalNode.PublicPort = 1
			models.LocalNode.PrivatePort = 1
			SyncNodeToConfig()

			if models.LocalNode.PublicHost != tt.wantHost {
				t.Errorf("LocalNode.PublicHost = %q, want %q", models.LocalNode.PublicHost, tt.wantHost)
			}
			if models.LocalNode.PrivateHost != tt.wantHost {
				t.Errorf("LocalNode.PrivateHost = %q, want %q", models.LocalNode.PrivateHost, tt.wantHost)
			}
			if models.LocalNode.PublicPort != tt.wantPort {
				t.Errorf("LocalNode.PublicPort = %d, want %d", models.LocalNode.PublicPort, tt.wantPort)
			}
			if models.LocalNode.PrivatePort != tt.wantPort {
				t.Errorf("LocalNode.PrivatePort = %d, want %d", models.LocalNode.PrivatePort, tt.wantPort)
			}
		})
	}
}

// regression for the SFTP half of the same bug family: daemon.sftp.host is a
// net.Listen bind string, so IPv6 binds are bracketed, and the old split lost
// their ports, leaving the advertised SFTP port stale
func TestSyncNodeToConfigSftpPort(t *testing.T) {
	origMasterUrl := config.MasterUrl.Value()
	origSftpHost := config.SftpHost.Value()
	t.Cleanup(func() {
		if err := config.MasterUrl.Set(origMasterUrl, false); err != nil {
			t.Errorf("restore masterUrl: %v", err)
		}
		if err := config.SftpHost.Set(origSftpHost, false); err != nil {
			t.Errorf("restore sftp host: %v", err)
		}
		SyncNodeToConfig()
	})

	tests := []struct {
		name     string
		sftpHost string
		wantPort uint16
	}{
		{name: "ipv4 bind", sftpHost: "0.0.0.0:5657", wantPort: 5657},
		{name: "bracketed ipv6 bind", sftpHost: "[::]:5658", wantPort: 5658},
		{name: "bracketed ipv6 loopback bind", sftpHost: "[::1]:5659", wantPort: 5659},
		{name: "no port leaves port unchanged", sftpHost: "0.0.0.0", wantPort: 7001},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := config.SftpHost.Set(tt.sftpHost, false); err != nil {
				t.Fatalf("set sftp host: %v", err)
			}
			// sentinel so unchanged-port cases cannot pass by luck
			models.LocalNode.SFTPPort = 7001

			SyncNodeToConfig()

			if models.LocalNode.SFTPPort != tt.wantPort {
				t.Errorf("LocalNode.SFTPPort = %d, want %d", models.LocalNode.SFTPPort, tt.wantPort)
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
