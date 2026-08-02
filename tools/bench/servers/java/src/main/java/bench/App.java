package bench;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotEmpty;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

/**
 * Spring Boot on its default stack: Spring MVC over embedded Tomcat, Jackson for
 * JSON, Hibernate Validator behind jakarta.validation. Nothing is tuned, no AOT,
 * no CDS, no GraalVM image - this is what `spring init` gives you.
 *
 * Tomcat is pinned to one worker thread in application.properties, because every
 * other subject in this suite is single-threaded. See the README, "Threads".
 */
@SpringBootApplication
@RestController
public class App {

  private static final String PLAINTEXT = "Hello, World!";
  private static final Message JSON_REPLY = new Message(PLAINTEXT);

  public record Message(String message) {}

  public record Param(String id) {}

  /** The same rules as the zod schema in servers/shared.ts. */
  public record Person(@NotEmpty String name, @Min(0) int age, @NotEmpty @Email String email) {}

  public record Echo(String name, int age) {}

  public record Invalid(String error) {}

  @GetMapping(value = "/plaintext", produces = MediaType.TEXT_PLAIN_VALUE)
  public String plaintext() {
    return PLAINTEXT;
  }

  @GetMapping("/json")
  public Message json() {
    return JSON_REPLY;
  }

  @GetMapping("/params/{id}")
  public Param params(@PathVariable String id) {
    return new Param(id);
  }

  @PostMapping("/validate")
  public Echo validate(@Valid @RequestBody Person person) {
    return new Echo(person.name(), person.age());
  }

  /** Never on the measured path; here so a rejected body answers the same bytes as every other subject. */
  @ExceptionHandler({MethodArgumentNotValidException.class, HttpMessageNotReadableException.class})
  @ResponseStatus(HttpStatus.BAD_REQUEST)
  public Invalid invalid() {
    return new Invalid("Invalid body");
  }

  public static void main(String[] args) {
    SpringApplication.run(App.class, args);
  }
}
