using System.Text.Json.Serialization;
using Npgsql;
using StackExchange.Redis;

namespace Bench;

/// <summary>
/// The io scenario's clients for both .NET subjects: Npgsql with its pool capped
/// at the size every subject is pinned to, and StackExchange.Redis on the one
/// multiplexed connection it is designed around.
///
/// Connected only when the harness passes both URLs, so the other four scenarios
/// run a process that has opened no socket and paid no connect in its startup
/// number.
/// </summary>
public sealed class Io
{
    private const string RedisKey = "bench:greeting";
    private const int RowId = 1;
    private const int PoolSize = 8;
    private const string Select = "SELECT id, memo, amount FROM bench_ledger WHERE id = $1";

    private readonly NpgsqlDataSource? _source;
    private readonly IDatabase? _redis;

    private Io(NpgsqlDataSource? source, IDatabase? redis)
    {
        _source = source;
        _redis = redis;
    }

    /// <summary>
    /// True when the harness enabled the scenario and both clients answered.
    /// `aspnet-minimal` maps the route only then; `aspnet-mvc` declares its action
    /// either way, because MVC reads a controller's routes off the class.
    /// </summary>
    public bool Enabled => _source is not null;

    /// <summary>
    /// Always returns an instance, so the MVC controller can take one by
    /// constructor whether or not the scenario is on. A disabled one throws if
    /// read, and only the io scenario requests that path.
    /// </summary>
    public static async Task<Io> ConnectAsync()
    {
        var pgUrl = Environment.GetEnvironmentVariable("BENCH_IO_PG_URL");
        var redisUrl = Environment.GetEnvironmentVariable("BENCH_IO_REDIS_URL");
        if (string.IsNullOrEmpty(pgUrl) || string.IsNullOrEmpty(redisUrl))
        {
            return new Io(null, null);
        }

        var builder = new NpgsqlDataSourceBuilder(ToNpgsql(pgUrl));
        var source = builder.Build();

        var multiplexer = await ConnectionMultiplexer.ConnectAsync(ToRedisOptions(redisUrl));

        var io = new Io(source, multiplexer.GetDatabase());
        // One round trip here, so the connect lands in the startup number where
        // every other subject's also is.
        await io.ReadAsync();
        return io;
    }

    /// <summary>
    /// StackExchange.Redis does not accept a `redis://` URL - it has its own
    /// comma-separated format - and every subject in the suite is handed the same
    /// URL, so it is taken apart here.
    ///
    /// The port and the credentials are both handled for the reason the Postgres
    /// branch below handles them: a `Uri` with no port reports `-1`, which would
    /// reach `Parse` as `host:-1`, and dropping `UserInfo` would fail against any
    /// Redis that asks for a password. The default URL has neither, which is
    /// exactly why this would have gone unnoticed.
    /// </summary>
    private static ConfigurationOptions ToRedisOptions(string url)
    {
        var parsed = new Uri(url);
        var options = ConfigurationOptions.Parse(
            $"{parsed.Host}:{(parsed.Port == -1 ? 6379 : parsed.Port)}");
        options.AbortOnConnectFail = true;

        var credentials = parsed.UserInfo.Split(':', 2);
        if (credentials.Length > 0 && credentials[0].Length > 0)
        {
            options.User = Uri.UnescapeDataString(credentials[0]);
        }
        if (credentials.Length > 1)
        {
            options.Password = Uri.UnescapeDataString(credentials[1]);
        }

        return options;
    }

    /// <summary>
    /// Npgsql takes a keyword connection string rather than a URL, and every
    /// other subject in the suite is handed the same `postgres://` one.
    /// </summary>
    private static string ToNpgsql(string url)
    {
        var parsed = new Uri(url);
        var credentials = parsed.UserInfo.Split(':', 2);
        return new NpgsqlConnectionStringBuilder
        {
            Host = parsed.Host,
            Port = parsed.Port == -1 ? 5432 : parsed.Port,
            Username = credentials.Length > 0 ? Uri.UnescapeDataString(credentials[0]) : "",
            Password = credentials.Length > 1 ? Uri.UnescapeDataString(credentials[1]) : "",
            Database = parsed.AbsolutePath.TrimStart('/'),
            MaxPoolSize = PoolSize,
            MinPoolSize = 1,
        }.ConnectionString;
    }

    /// <summary>One Redis GET, then one parameterised Postgres SELECT.</summary>
    public async Task<IoPayload> ReadAsync()
    {
        if (_source is null || _redis is null)
        {
            throw new InvalidOperationException("io is not connected: BENCH_IO_PG_URL is unset");
        }

        var cached = await _redis.StringGetAsync(RedisKey);

        await using var command = _source.CreateCommand(Select);
        command.Parameters.AddWithValue(RowId);
        await using var reader = await command.ExecuteReaderAsync();
        if (!await reader.ReadAsync())
        {
            return new IoPayload(cached.ToString() ?? "missing", 0, "missing", 0);
        }

        return new IoPayload(
            cached.ToString() ?? "missing",
            reader.GetInt32(0),
            reader.GetString(1),
            reader.GetInt32(2));
    }
}

/// <summary>
/// Property order is JSON property order for System.Text.Json, and the harness
/// compares bytes.
/// </summary>
public sealed record IoPayload(
    [property: JsonPropertyOrder(0)] string Cached,
    [property: JsonPropertyOrder(1)] int Id,
    [property: JsonPropertyOrder(2)] string Memo,
    [property: JsonPropertyOrder(3)] int Amount);
