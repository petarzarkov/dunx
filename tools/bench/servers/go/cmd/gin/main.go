// Gin, the Go framework Elysia's landing page compares itself against.
package main

import (
	"net/http"
	"runtime"

	"github.com/gin-gonic/gin"

	"dunxbench/shared"
)

// One thread, for the reason in cmd/nethttp/main.go and the README, "Threads".
func init() { runtime.GOMAXPROCS(1) }

func main() {
	gin.SetMode(gin.ReleaseMode)

	// gin.New(), not gin.Default(): Default installs a per-request logger and a
	// recovery middleware. Nothing else in this suite logs or recovers, and the
	// logger alone is worth more than most of the gaps in the table.
	router := gin.New()

	router.GET("/plaintext", func(c *gin.Context) {
		c.String(http.StatusOK, shared.Plaintext)
	})

	router.GET("/json", func(c *gin.Context) {
		c.JSON(http.StatusOK, shared.JSONReply)
	})

	router.GET("/params/:id", func(c *gin.Context) {
		c.JSON(http.StatusOK, shared.Param{ID: c.Param("id")})
	})

	router.POST("/validate", func(c *gin.Context) {
		var person shared.Person
		if err := c.ShouldBindJSON(&person); err != nil {
			c.JSON(http.StatusBadRequest, shared.BadBody)
			return
		}
		c.JSON(http.StatusOK, shared.Echo{Name: person.Name, Age: person.Age})
	})

	if err := router.Run(shared.Addr()); err != nil {
		panic(err)
	}
}
