package auth

import (
	"crypto/tls"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/pufferpanel/pufferpanel/v3/config"
	"github.com/pufferpanel/pufferpanel/v3/models"
	"github.com/pufferpanel/pufferpanel/v3/scopes"
	"github.com/pufferpanel/pufferpanel/v3/services"
	"github.com/spf13/viper"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func TestAuthCookieSecureAndLogout(t *testing.T) {
	gin.SetMode(gin.TestMode)
	previous := viper.Get(config.PanelWebCookiesSecure.Key())
	t.Cleanup(func() { viper.Set(config.PanelWebCookiesSecure.Key(), previous) })

	for _, configuredSecure := range []bool{false, true} {
		for _, directTLS := range []bool{false, true} {
			t.Run(fmt.Sprintf("configured_%t/tls_%t", configuredSecure, directTLS), func(t *testing.T) {
				if err := config.PanelWebCookiesSecure.Set(configuredSecure, false); err != nil {
					t.Fatal(err)
				}
				db := authTestDB(t)
				user := &models.User{Username: "testuser", Email: "test@example.com", HashedPassword: "unused"}
				if err := db.Create(user).Error; err != nil {
					t.Fatal(err)
				}
				permission := &models.Permissions{UserId: &user.ID, Scopes: []*scopes.Scope{scopes.ScopeLogin}}
				if err := db.Create(permission).Error; err != nil {
					t.Fatal(err)
				}

				login, loginRecorder := authContext(http.MethodPost, "/login", db, directTLS)
				login.Request.Header.Set("X-Forwarded-Proto", "https")
				createSession(login, user)
				if loginRecorder.Code != http.StatusOK {
					t.Fatalf("login status = %d, want %d", loginRecorder.Code, http.StatusOK)
				}
				authCookie := cookieByName(t, loginRecorder, "puffer_auth")
				expiresCookie := cookieByName(t, loginRecorder, "puffer_auth_expires")
				wantSecure := configuredSecure || directTLS
				checkCookie(t, authCookie, wantSecure, true, 3600)
				checkCookie(t, expiresCookie, wantSecure, false, 3600)
				if authCookie.Value == "" || expiresCookie.Value != "" {
					t.Fatalf("unexpected issued cookie values: auth empty=%t, expires=%q", authCookie.Value == "", expiresCookie.Value)
				}

				if _, err := (&services.Session{DB: db}).Validate(authCookie.Value); err != nil {
					t.Fatalf("issued session does not validate: %v", err)
				}
				logout, logoutRecorder := authContext(http.MethodPost, "/logout", db, directTLS)
				logout.Request.Header.Set("X-Forwarded-Proto", "https")
				logout.Request.AddCookie(authCookie)
				LogoutPost(logout)
				logout.Writer.WriteHeaderNow()
				if logoutRecorder.Code != http.StatusNoContent {
					t.Fatalf("logout status = %d, want %d", logoutRecorder.Code, http.StatusNoContent)
				}
				checkCookie(t, cookieByName(t, logoutRecorder, "puffer_auth"), wantSecure, true, -1)
				checkCookie(t, cookieByName(t, logoutRecorder, "puffer_auth_expires"), wantSecure, false, -1)
				if _, err := (&services.Session{DB: db}).Validate(authCookie.Value); !errors.Is(err, gorm.ErrRecordNotFound) {
					t.Fatalf("logged-out session validation = %v, want record not found", err)
				}
			})
		}
	}
}

func TestLogoutWithoutCookieAndFailedLoginSetNoAuthCookies(t *testing.T) {
	gin.SetMode(gin.TestMode)
	previous := viper.Get(config.PanelWebCookiesSecure.Key())
	t.Cleanup(func() { viper.Set(config.PanelWebCookiesSecure.Key(), previous) })
	if err := config.PanelWebCookiesSecure.Set(true, false); err != nil {
		t.Fatal(err)
	}

	logout, logoutRecorder := authContext(http.MethodPost, "/logout", nil, false)
	LogoutPost(logout)
	logout.Writer.WriteHeaderNow()
	if logoutRecorder.Code != http.StatusNoContent || len(logoutRecorder.Header().Values("Set-Cookie")) != 0 {
		t.Fatalf("no-cookie logout: status=%d cookies=%v", logoutRecorder.Code, logoutRecorder.Header().Values("Set-Cookie"))
	}

	db := authTestDB(t)
	user := &models.User{Username: "testuser", Email: "test@example.com", HashedPassword: "unused"}
	if err := db.Create(user).Error; err != nil {
		t.Fatal(err)
	}
	permission := &models.Permissions{UserId: &user.ID}
	if err := db.Create(permission).Error; err != nil {
		t.Fatal(err)
	}
	login, recorder := authContext(http.MethodPost, "/login", db, false)
	createSession(login, user)
	login.Writer.WriteHeaderNow()
	if recorder.Code != http.StatusForbidden || len(recorder.Header().Values("Set-Cookie")) != 0 {
		t.Fatalf("failed login: status=%d cookies=%v", recorder.Code, recorder.Header().Values("Set-Cookie"))
	}
}

func authTestDB(t *testing.T) *gorm.DB {
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
	if err := db.AutoMigrate(&models.User{}, &models.Permissions{}, &models.Session{}); err != nil {
		t.Fatal(err)
	}
	return db
}

func authContext(method, target string, db *gorm.DB, directTLS bool) (*gin.Context, *httptest.ResponseRecorder) {
	request := httptest.NewRequest(method, target, nil)
	if directTLS {
		request.TLS = &tls.ConnectionState{}
	}
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = request
	ctx.Set("db", db)
	return ctx, recorder
}

func cookieByName(t *testing.T, recorder *httptest.ResponseRecorder, name string) *http.Cookie {
	t.Helper()
	for _, cookie := range recorder.Result().Cookies() {
		if cookie.Name == name {
			return cookie
		}
	}
	t.Fatalf("response did not set %q cookie: %v", name, recorder.Header().Values("Set-Cookie"))
	return nil
}

func checkCookie(t *testing.T, cookie *http.Cookie, secure, httpOnly bool, maxAge int) {
	t.Helper()
	if cookie.Secure != secure || cookie.HttpOnly != httpOnly || cookie.MaxAge != maxAge || cookie.Path != "/" || cookie.Domain != "" {
		t.Errorf("cookie %q attributes = {Secure:%t HttpOnly:%t MaxAge:%d Path:%q Domain:%q}, want {%t %t %d / empty}", cookie.Name, cookie.Secure, cookie.HttpOnly, cookie.MaxAge, cookie.Path, cookie.Domain, secure, httpOnly, maxAge)
	}
}
