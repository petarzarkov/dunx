// The Go floor: net/http and nothing else, mirroring what node-http and
// bun-serve are for their runtimes.
//
// Routing is http.ServeMux with Go 1.22 method-and-wildcard patterns, which is
// the standard library's own router, so this is the same shape of comparison as
// bun-serve using Bun.serve({ routes }).
package main

import (
	"encoding/json"
	"net/http"
	"runtime"

	"dunxbench/shared"
)

// One thread, because every other subject in this suite is single-threaded and
// a 32-core Go server measured against a single-threaded JavaScript one is not
// a framework comparison. See the README, "Threads".
func init() { runtime.GOMAXPROCS(1) }

var (
	textType = "text/plain; charset=utf-8"
	jsonType = "application/json; charset=utf-8"
)

// json.Encoder appends a newline, which would fail the harness's byte-identical
// contract check, so this marshals and writes.
func writeJSON(w http.ResponseWriter, status int, body any) {
	encoded, err := json.Marshal(body)
	if err != nil {
		http.Error(w, "", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", jsonType)
	w.WriteHeader(status)
	_, _ = w.Write(encoded)
}

func main() {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /plaintext", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", textType)
		_, _ = w.Write([]byte(shared.Plaintext))
	})

	mux.HandleFunc("GET /json", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, shared.JSONReply)
	})

	mux.HandleFunc("GET /params/{id}", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, shared.Param{ID: r.PathValue("id")})
	})

	mux.HandleFunc("POST /validate", func(w http.ResponseWriter, r *http.Request) {
		var person shared.Person
		if err := json.NewDecoder(r.Body).Decode(&person); err != nil {
			writeJSON(w, http.StatusBadRequest, shared.BadBody)
			return
		}
		if err := shared.Validate.Struct(person); err != nil {
			writeJSON(w, http.StatusBadRequest, shared.BadBody)
			return
		}
		writeJSON(w, http.StatusOK, shared.Echo{Name: person.Name, Age: person.Age})
	})

	server := &http.Server{Addr: shared.Addr(), Handler: mux}
	if err := server.ListenAndServe(); err != nil {
		panic(err)
	}
}
