package services

import (
	"testing"

	"github.com/pufferpanel/pufferpanel/v3/models"
	"github.com/pufferpanel/pufferpanel/v3/scopes"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func createPermissionTestDB(t *testing.T) *gorm.DB {
	t.Helper()

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
	if err := db.AutoMigrate(&models.User{}, &models.Permissions{}, &models.Client{}); err != nil {
		t.Fatal(err)
	}
	return db
}

func createPermissionTestUser(t *testing.T, db *gorm.DB, name string, globalScopes []*scopes.Scope, serverScopes []*scopes.Scope) *models.User {
	t.Helper()

	user := &models.User{Username: name, Email: name + "@example.test", HashedPassword: "notarealhash"}
	if err := db.Create(user).Error; err != nil {
		t.Fatal(err)
	}
	if globalScopes != nil {
		if err := db.Create(&models.Permissions{UserId: &user.ID, Scopes: globalScopes}).Error; err != nil {
			t.Fatal(err)
		}
	}
	if serverScopes != nil {
		server := "testserver-" + name
		if err := db.Create(&models.Permissions{UserId: &user.ID, ServerIdentifier: &server, Scopes: serverScopes}).Error; err != nil {
			t.Fatal(err)
		}
	}
	return user
}

func TestCountOtherAdmins(t *testing.T) {
	db := createPermissionTestDB(t)

	//the only admin in the panel: nobody else can take over
	loneAdmin := createPermissionTestUser(t, db, "loneadmin", []*scopes.Scope{scopes.ScopeAdmin}, nil)
	//a plain user with login rights but no admin scope
	regular := createPermissionTestUser(t, db, "regular", []*scopes.Scope{scopes.ScopeLogin}, nil)
	//server-scoped permissions must never count as panel admin
	serverAdmin := createPermissionTestUser(t, db, "serveradmin", []*scopes.Scope{scopes.ScopeLogin},
		[]*scopes.Scope{scopes.ScopeServerAdmin, scopes.ScopeServerView})
	//no permissions row at all
	createPermissionTestUser(t, db, "noperms", nil, nil)

	ps := &Permission{DB: db}

	if count, err := ps.CountOtherAdmins(loneAdmin.ID); err != nil || count != 0 {
		t.Errorf("CountOtherAdmins(loneAdmin) = %d, %v; want 0, nil", count, err)
	}
	if count, err := ps.CountOtherAdmins(regular.ID); err != nil || count != 1 {
		t.Errorf("CountOtherAdmins(regular) = %d, %v; want 1, nil", count, err)
	}
	if count, err := ps.CountOtherAdmins(serverAdmin.ID); err != nil || count != 1 {
		t.Errorf("CountOtherAdmins(serverAdmin) = %d, %v; want 1, nil", count, err)
	}

	//a second admin means neither of them is the last one
	createPermissionTestUser(t, db, "secondadmin", []*scopes.Scope{scopes.ScopeAdmin, scopes.ScopeLogin}, nil)
	if count, err := ps.CountOtherAdmins(loneAdmin.ID); err != nil || count != 1 {
		t.Errorf("CountOtherAdmins(loneAdmin) after second admin = %d, %v; want 1, nil", count, err)
	}
}

func TestCountOtherAdminsIgnoresClients(t *testing.T) {
	db := createPermissionTestDB(t)

	admin := createPermissionTestUser(t, db, "admin", []*scopes.Scope{scopes.ScopeAdmin}, nil)

	client := &models.Client{ClientId: "clientid", Name: "client", User: admin}
	if err := db.Create(client).Error; err != nil {
		t.Fatal(err)
	}
	//a client holding the admin scope is not a rescue option for the panel
	if err := db.Create(&models.Permissions{ClientId: &client.ID, Scopes: []*scopes.Scope{scopes.ScopeAdmin}}).Error; err != nil {
		t.Fatal(err)
	}

	ps := &Permission{DB: db}
	if count, err := ps.CountOtherAdmins(admin.ID); err != nil || count != 0 {
		t.Errorf("CountOtherAdmins(admin) = %d, %v; want 0, nil", count, err)
	}
}
