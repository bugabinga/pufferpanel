package services

import (
	"encoding/base64"
	"testing"

	webauthnProto "github.com/go-webauthn/webauthn/protocol"
	webauthn "github.com/go-webauthn/webauthn/webauthn"
	"github.com/pufferpanel/pufferpanel/v3/config"
	"github.com/pufferpanel/pufferpanel/v3/models"
	"github.com/stretchr/testify/assert"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
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

func TestUserDeletePasskeyIsScopedToOwner(t *testing.T) {
	db, err := gorm.Open(sqlite.Open("file:"+t.Name()+"?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := sqlDB.Close(); err != nil {
			t.Error(err)
		}
	})
	if err := db.AutoMigrate(&models.User{}, &models.WebauthnCredential{}); err != nil {
		t.Fatal(err)
	}

	owner := &models.User{Username: "passkey_owner", Email: "owner@example.test", HashedPassword: "notarealhash"}
	other := &models.User{Username: "passkey_victim", Email: "victim@example.test", HashedPassword: "notarealhash"}
	for _, u := range []*models.User{owner, other} {
		if err := db.Create(u).Error; err != nil {
			t.Fatal(err)
		}
	}

	rawID := []byte("credential-id-one")
	stored := &models.WebauthnCredential{
		ID:         webauthnProto.URLEncodedBase64(rawID),
		Name:       "victim key",
		UserId:     other.ID,
		Credential: webauthn.Credential{ID: rawID, PublicKey: []byte("pk"), AttestationType: "none"},
	}
	if err := db.Create(stored).Error; err != nil {
		t.Fatal(err)
	}

	us := &User{DB: db}
	encodedID := base64.RawURLEncoding.EncodeToString(rawID)

	// a different user attempting to delete the credential must not remove it
	if err := us.DeletePasskey(owner.ID, encodedID); err != nil {
		t.Fatalf("DeletePasskey by non-owner returned error: %v", err)
	}
	var count int64
	if err := db.Model(&models.WebauthnCredential{}).Where("user_id = ?", other.ID).Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	if !assert.EqualValues(t, 1, count, "non-owner delete removed the victim credential") {
		return
	}

	// the actual owner can delete it
	if err := us.DeletePasskey(other.ID, encodedID); err != nil {
		t.Fatalf("DeletePasskey by owner returned error: %v", err)
	}
	if err := db.Model(&models.WebauthnCredential{}).Where("user_id = ?", other.ID).Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	assert.EqualValues(t, 0, count, "owner delete did not remove the credential")
}
