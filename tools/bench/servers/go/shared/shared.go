// Package shared holds the payload shapes and the one validator every Go subject
// uses, so `net/http` and Gin differ only in the framework and not in the work.
package shared

import (
	"os"

	"github.com/go-playground/validator/v10"
)

const Plaintext = "Hello, World!"

type Message struct {
	Message string `json:"message"`
}

type Param struct {
	ID string `json:"id"`
}

// Person carries both tag dialects on purpose: Gin's binding reads `binding`,
// and the net/http subject calls validator/v10 directly, which reads `validate`.
// The rules are the same in both, and the same as the zod schema in shared.ts.
type Person struct {
	Name  string `json:"name" binding:"required,min=1" validate:"required,min=1"`
	Age   int    `json:"age" binding:"gte=0" validate:"gte=0"`
	Email string `json:"email" binding:"required,email" validate:"required,email"`
}

type Echo struct {
	Name string `json:"name"`
	Age  int    `json:"age"`
}

type Invalid struct {
	Error string `json:"error"`
}

var (
	Validate  = validator.New(validator.WithRequiredStructEnabled())
	BadBody   = Invalid{Error: "Invalid body"}
	JSONReply = Message{Message: Plaintext}
)

// Addr reads PORT the way every other subject in the suite does.
func Addr() string {
	port := os.Getenv("PORT")
	if port == "" {
		port = "0"
	}
	return "127.0.0.1:" + port
}
