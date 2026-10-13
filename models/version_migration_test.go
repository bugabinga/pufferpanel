package models_test

import (
	"testing"

	"github.com/pufferpanel/pufferpanel/v3/models"
)

func TestValidationMajorMigrationPreservesRequiredAndIgnoredAssociations(t *testing.T) {
	server := &models.Server{
		Identifier: "server",
		Type:       "generic",
	}
	if err := server.IsValid(); err == nil || err.Error() != "Name: required" {
		t.Errorf("Server.IsValid() error = %v, want Name: required", err)
	}

	server.Name = "server"
	if err := server.IsValid(); err != nil {
		t.Errorf("Server.IsValid() error = %v, want nil", err)
	}
}
