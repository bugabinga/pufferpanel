package tests

import (
	"encoding/json"
	"fmt"
	"github.com/pufferpanel/pufferpanel/v3/models"
	"github.com/pufferpanel/pufferpanel/v3/scopes"
	"github.com/stretchr/testify/assert"
	"net/http"
	"testing"
)

func TestUserApi(t *testing.T) {
	session, err := createSessionAdmin()
	if !assert.NoError(t, err) {
		return
	}

	t.Run("TestUserWithPerms", func(t *testing.T) {
		url := fmt.Sprintf("/api/users/%d/perms", loginNoServerViewUser.ID)
		response := CallAPI("GET", url, nil, session)
		if !assert.Equal(t, http.StatusOK, response.Code) {
			return
		}

		perms := &models.PermissionView{}
		err = json.NewDecoder(response.Body).Decode(perms)
		if !assert.NoError(t, err) {
			return
		}

		if !assert.NotEmpty(t, perms.Scopes) {
			return
		}
	})

	var newUserId uint

	t.Run("CreateUser", func(t *testing.T) {
		response := CallAPI("POST", "/api/users", map[string]string{
			"username": "apicreateduser",
			"email":    "none@example.com",
			"password": "testing123!",
		}, session)
		if !assert.Equal(t, http.StatusOK, response.Code) {
			return
		}

		user := &models.UserView{}
		err = json.NewDecoder(response.Body).Decode(user)
		if !assert.NoError(t, err) {
			return
		}
		newUserId = user.Id
	})

	t.Run("TestEmptyUserPerms", func(t *testing.T) {
		url := fmt.Sprintf("/api/users/%d/perms", newUserId)
		response := CallAPI("GET", url, nil, session)
		if !assert.Equal(t, http.StatusOK, response.Code) {
			return
		}

		perms := &models.PermissionView{}
		err = json.NewDecoder(response.Body).Decode(perms)
		if !assert.NoError(t, err) {
			return
		}

		if !assert.Empty(t, perms.Scopes) {
			return
		}
	})

	t.Run("TestSetEmptyPerms", func(t *testing.T) {
		url := fmt.Sprintf("/api/users/%d/perms", newUserId)
		response := CallAPI("PUT", url, map[string]interface{}{
			"scopes": []string{},
		}, session)
		if !assert.Equal(t, http.StatusNoContent, response.Code) {
			return
		}

		response = CallAPI("GET", url, nil, session)
		if !assert.Equal(t, http.StatusOK, response.Code) {
			return
		}

		perms := &models.PermissionView{}
		err = json.NewDecoder(response.Body).Decode(perms)
		if !assert.NoError(t, err) {
			return
		}

		if !assert.Empty(t, perms.Scopes) {
			return
		}
	})

	t.Run("TestDelete", func(t *testing.T) {
		url := fmt.Sprintf("/api/users/%d", newUserId)
		response := CallAPI("DELETE", url, nil, session)
		if !assert.Equal(t, http.StatusNoContent, response.Code) {
			return
		}
	})
}

// regression tests for admin lockouts: an editor can no longer strip their own
// login scope, demote themselves as the last admin, or delete the last admin
func TestUserPermLockoutGuards(t *testing.T) {
	session, err := createSessionAdmin()
	if !assert.NoError(t, err) {
		return
	}
	adminId := loginAdminUser.ID

	readOwnScopes := func() []string {
		response := CallAPI("GET", fmt.Sprintf("/api/users/%d/perms", adminId), nil, session)
		if !assert.Equal(t, http.StatusOK, response.Code) {
			return nil
		}
		perms := &models.PermissionView{}
		if !assert.NoError(t, json.NewDecoder(response.Body).Decode(perms)) {
			return nil
		}
		scopes := make([]string, len(perms.Scopes))
		for i, s := range perms.Scopes {
			scopes[i] = s.String()
		}
		return scopes
	}

	t.Run("CannotRemoveOwnLogin", func(t *testing.T) {
		url := fmt.Sprintf("/api/users/%d/perms", adminId)
		response := CallAPI("PUT", url, map[string]interface{}{
			"scopes": []string{"self.edit"},
		}, session)
		if !assert.Equal(t, http.StatusBadRequest, response.Code) {
			return
		}
		assert.Contains(t, response.Body.String(), "ErrCannotRemoveOwnLogin")
		assert.Contains(t, readOwnScopes(), scopes.ScopeAdmin.Value)
	})

	t.Run("CannotDemoteSelfAsLastAdmin", func(t *testing.T) {
		url := fmt.Sprintf("/api/users/%d/perms", adminId)
		response := CallAPI("PUT", url, map[string]interface{}{
			"scopes": []string{"login"},
		}, session)
		if !assert.Equal(t, http.StatusBadRequest, response.Code) {
			return
		}
		assert.Contains(t, response.Body.String(), "ErrCannotRemoveLastAdmin")
		assert.Contains(t, readOwnScopes(), scopes.ScopeAdmin.Value)
	})

	t.Run("CannotDeleteLastAdmin", func(t *testing.T) {
		url := fmt.Sprintf("/api/users/%d", adminId)
		response := CallAPI("DELETE", url, nil, session)
		assert.Equal(t, http.StatusBadRequest, response.Code)
		assert.Contains(t, response.Body.String(), "ErrCannotRemoveLastAdmin")
	})

	//with a second admin around, demotions and deletions of others are fine
	var otherAdminId uint

	t.Run("CreateSecondAdmin", func(t *testing.T) {
		response := CallAPI("POST", "/api/users", map[string]string{
			"username": "lockoutguarduser",
			"email":    "lockoutguard@example.com",
			"password": "testing123!",
		}, session)
		if !assert.Equal(t, http.StatusOK, response.Code) {
			return
		}

		user := &models.UserView{}
		if !assert.NoError(t, json.NewDecoder(response.Body).Decode(user)) {
			return
		}
		otherAdminId = user.Id

		response = CallAPI("PUT", fmt.Sprintf("/api/users/%d/perms", otherAdminId), map[string]interface{}{
			"scopes": []string{"admin"},
		}, session)
		assert.Equal(t, http.StatusNoContent, response.Code)
	})

	t.Run("CanDemoteOtherAdmin", func(t *testing.T) {
		url := fmt.Sprintf("/api/users/%d/perms", otherAdminId)
		response := CallAPI("PUT", url, map[string]interface{}{
			"scopes": []string{"login"},
		}, session)
		assert.Equal(t, http.StatusNoContent, response.Code)
	})

	t.Run("CanRevokeOtherLogin", func(t *testing.T) {
		url := fmt.Sprintf("/api/users/%d/perms", otherAdminId)
		response := CallAPI("PUT", url, map[string]interface{}{
			"scopes": []string{},
		}, session)
		assert.Equal(t, http.StatusNoContent, response.Code)
	})

	t.Run("CanDeleteOtherUser", func(t *testing.T) {
		url := fmt.Sprintf("/api/users/%d", otherAdminId)
		response := CallAPI("DELETE", url, nil, session)
		assert.Equal(t, http.StatusNoContent, response.Code)
	})
}
