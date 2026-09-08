package bench;

import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import io.lettuce.core.RedisClient;
import io.lettuce.core.api.StatefulRedisConnection;
import io.lettuce.core.api.sync.RedisCommands;
import java.net.URI;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;

/**
 * The io scenario's clients for the Spring subject: JDBC through HikariCP, pooled
 * to the size every subject is pinned to, and Lettuce on the one multiplexed
 * connection it is built around.
 *
 * <p>Lettuce and HikariCP are direct dependencies rather than
 * {@code spring-boot-starter-data-redis} and {@code spring-boot-starter-jdbc}. The
 * starters would add autoconfiguration to every scenario's Spring context, and the
 * four scenarios that predate this one have to keep booting the context they were
 * measured on.
 *
 * <p><b>Both calls block the Tomcat worker.</b> That is what a Spring MVC stack
 * does, and with Tomcat pinned to one thread it means one request in flight for
 * the whole round trip. See the README, "Blocking subjects on the io scenario".
 */
public final class Io {

  private static final String REDIS_KEY = "bench:greeting";
  private static final int ROW_ID = 1;
  private static final int POOL_SIZE = 8;
  private static final String SELECT =
      "SELECT id, memo, amount FROM bench_ledger WHERE id = ?";

  /** Jackson serialises a record in declaration order, and the harness compares bytes. */
  public record IoPayload(String cached, int id, String memo, int amount) {}

  private static Io instance;

  private final HikariDataSource pool;
  private final RedisCommands<String, String> redis;

  private Io(HikariDataSource pool, RedisCommands<String, String> redis) {
    this.pool = pool;
    this.redis = redis;
  }

  /** Called from {@code main} before Spring starts, so the connect is startup work. */
  public static void connect() throws Exception {
    var pgUrl = System.getenv("BENCH_IO_PG_URL");
    var redisUrl = System.getenv("BENCH_IO_REDIS_URL");
    if (pgUrl == null || pgUrl.isEmpty() || redisUrl == null || redisUrl.isEmpty()) {
      return;
    }

    var parsed = URI.create(pgUrl);
    var credentials = parsed.getUserInfo() == null ? new String[0] : parsed.getUserInfo().split(":", 2);
    var config = new HikariConfig();
    config.setJdbcUrl(
        "jdbc:postgresql://"
            + parsed.getHost()
            + ":"
            + (parsed.getPort() == -1 ? 5432 : parsed.getPort())
            + parsed.getPath());
    if (credentials.length > 0) {
      config.setUsername(credentials[0]);
    }
    if (credentials.length > 1) {
      config.setPassword(credentials[1]);
    }
    config.setMaximumPoolSize(POOL_SIZE);
    config.setMinimumIdle(1);
    var pool = new HikariDataSource(config);

    StatefulRedisConnection<String, String> connection = RedisClient.create(redisUrl).connect();

    var io = new Io(pool, connection.sync());
    // One round trip here, so the connect lands in the startup number where every
    // other subject's also is.
    io.read();
    instance = io;
  }

  public static boolean enabled() {
    return instance != null;
  }

  /** One Redis GET, then one parameterised Postgres SELECT. */
  public static IoPayload current() throws Exception {
    if (instance == null) {
      throw new IllegalStateException("io is not connected: BENCH_IO_PG_URL is unset");
    }
    return instance.read();
  }

  private IoPayload read() throws Exception {
    var cached = redis.get(REDIS_KEY);
    try (Connection connection = pool.getConnection();
        PreparedStatement statement = connection.prepareStatement(SELECT)) {
      statement.setInt(1, ROW_ID);
      try (ResultSet rows = statement.executeQuery()) {
        if (!rows.next()) {
          return new IoPayload(cached == null ? "missing" : cached, 0, "missing", 0);
        }
        return new IoPayload(
            cached == null ? "missing" : cached,
            rows.getInt(1),
            rows.getString(2),
            rows.getInt(3));
      }
    }
  }
}
