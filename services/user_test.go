package services

import (
	"testing"

	"github.com/pufferpanel/pufferpanel/v3/config"
)

func TestUserWebAuthnRelyingPartyConfig(t *testing.T) {
	originalMasterURL := config.MasterUrl.Value()
	originalCompanyName := config.CompanyName.Value()
	t.Cleanup(func() {
		_ = config.MasterUrl.Set(originalMasterURL, false)
		_ = config.CompanyName.Set(originalCompanyName, false)
	})
	if err := config.CompanyName.Set("PufferPanel test", false); err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		name      string
		masterURL string
		wantRPID  string
		wantErr   bool
	}{
		{name: "https default port", masterURL: "https://panel.example.test", wantRPID: "panel.example.test"},
		{name: "https non-default port", masterURL: "https://panel.example.test:8443", wantRPID: "panel.example.test"},
		{name: "localhost", masterURL: "https://localhost:8443", wantRPID: "localhost"},
		{name: "invalid URL", masterURL: "://invalid", wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := config.MasterUrl.Set(tt.masterURL, false); err != nil {
				t.Fatal(err)
			}

			webAuthn, err := (&User{}).webAuthn()
			if tt.wantErr {
				if err == nil {
					t.Fatal("webAuthn() error = nil, want parse error")
				}
				return
			}
			if err != nil {
				t.Fatalf("webAuthn() error = %v", err)
			}

			if got := webAuthn.Config.RPID; got != tt.wantRPID {
				t.Errorf("RPID = %q, want %q", got, tt.wantRPID)
			}
			if got := webAuthn.Config.RPOrigins; len(got) != 1 || got[0] != tt.masterURL {
				t.Errorf("RPOrigins = %q, want [%q]", got, tt.masterURL)
			}
			if got := webAuthn.Config.RPDisplayName; got != "PufferPanel test" {
				t.Errorf("RPDisplayName = %q, want %q", got, "PufferPanel test")
			}
		})
	}
}
