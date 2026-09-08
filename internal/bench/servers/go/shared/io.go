// The io scenario's clients for both Go subjects: pgx for Postgres and go-redis
// for Redis, each pooled to the size every subject in the suite is pinned to.
//
// Opened only when the harness passes both URLs, so the other four scenarios run
// a process that has opened no socket and paid no connect in its startup number.
package shared

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"strconv"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

const (
	ioRedisKey = "bench:greeting"
	ioRowID    = 1
	ioPoolSize = 8
	ioSelect   = "SELECT id, memo, amount FROM bench_ledger WHERE id = $1"
)

// IoPayload's field order is the JSON field order, and the harness compares bytes.
type IoPayload struct {
	Cached string `json:"cached"`
	ID     int32  `json:"id"`
	Memo   string `json:"memo"`
	Amount int32  `json:"amount"`
}

type Io struct {
	pool  *pgxpool.Pool
	redis *redis.Client
}

// NewIo returns nil when the harness did not enable the scenario, which is what
// the callers branch on before registering the route.
func NewIo(ctx context.Context) (*Io, error) {
	pgURL := os.Getenv("BENCH_IO_PG_URL")
	redisURL := os.Getenv("BENCH_IO_REDIS_URL")
	if pgURL == "" || redisURL == "" {
		return nil, nil
	}

	config, err := pgxpool.ParseConfig(pgURL)
	if err != nil {
		return nil, err
	}
	config.MaxConns = ioPoolSize
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return nil, err
	}

	options, err := redis.ParseURL(redisURL)
	if err != nil {
		return nil, err
	}
	options.PoolSize = ioPoolSize
	client := redis.NewClient(options)

	io := &Io{pool: pool, redis: client}
	// Both clients connect lazily. Doing it here puts the connect in the startup
	// number, where every other subject's also is.
	if _, err := io.Read(ctx); err != nil {
		return nil, err
	}
	return io, nil
}

// Read is the contract: one Redis GET, then one parameterised Postgres SELECT.
func (io *Io) Read(ctx context.Context) (IoPayload, error) {
	cached, err := io.redis.Get(ctx, ioRedisKey).Result()
	if err != nil {
		return IoPayload{}, err
	}
	var payload IoPayload
	payload.Cached = cached
	row := io.pool.QueryRow(ctx, ioSelect, ioRowID)
	if err := row.Scan(&payload.ID, &payload.Memo, &payload.Amount); err != nil {
		return IoPayload{}, err
	}
	return payload, nil
}

// WriteTo answers an http.ResponseWriter directly, so cmd/nethttp needs no copy
// of the encode-and-write dance and cmd/gin can hand it gin's writer.
func (io *Io) WriteTo(w http.ResponseWriter, r *http.Request) {
	payload, err := io.Read(r.Context())
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		http.Error(w, "", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(encoded)
}

// IoPoolSize is reported in the subject registry, so the number in the docs and
// the number in the code cannot drift.
var IoPoolSize = strconv.Itoa(ioPoolSize)
