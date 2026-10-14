package auth

import (
	"errors"
	"github.com/gin-gonic/gin"
	"github.com/pufferpanel/pufferpanel/v3/config"
	"github.com/pufferpanel/pufferpanel/v3/middleware"
	"github.com/pufferpanel/pufferpanel/v3/services"
	"net/http"
)

func LogoutPost(c *gin.Context) {
	db := middleware.GetDatabase(c)
	ss := services.Session{DB: db}

	var err error
	cookie := c.Query("token")
	if cookie == "" {
		cookie, err = c.Cookie("puffer_auth")
		if errors.Is(err, http.ErrNoCookie) {
			c.Status(http.StatusNoContent)
			return
		}
	}

	_ = ss.Expire(cookie)

	secure := config.PanelWebCookiesSecure.Value() || c.Request.TLS != nil

	c.SetCookie("puffer_auth", "", -1, "/", "", secure, true)
	c.SetCookie("puffer_auth_expires", "", -1, "/", "", secure, false)
	c.Status(http.StatusNoContent)
}
