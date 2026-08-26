// ASP.NET Core MVC: attribute-routed controllers, model binding, automatic model
// validation and a controller resolved from the DI container on every request.
//
// This is the .NET row to read against `spring` and the NestJS rows - all three
// are the controllers-and-DI programming model dunx borrows its shape from, and
// `aspnet-minimal` is the same runtime and server without it.
using Bench;
using Microsoft.AspNetCore.Mvc;

// One thread, because every other subject in this suite is single-threaded. See
// the README, "Threads".
Shared.PinToOneThread();

var builder = WebApplication.CreateBuilder(args);
builder.WebHost.UseSockets(options => options.IOQueueCount = 1);
builder.WebHost.UseUrls(Shared.Url());
builder.Logging.SetMinimumLevel(LogLevel.Warning);

builder.Services.AddSingleton<Greeter>();
builder.Services
    .AddControllers()
    // Never on the measured path; here so a rejected body answers the same bytes
    // as every other subject rather than [ApiController]'s ProblemDetails.
    .ConfigureApiBehaviorOptions(options =>
        options.InvalidModelStateResponseFactory = _ => new BadRequestObjectResult(Shared.BadBody));

var app = builder.Build();
app.MapControllers();
app.Run();

/// <summary>
/// A constructor-injected dependency, handed to the controller the container
/// builds for each request. It is here because that is how a real MVC app is
/// written, and it is what the `dunx` subject's injected service is compared
/// against.
/// </summary>
public sealed class Greeter
{
    public string Text() => Shared.Plaintext;

    public Greeting Payload() => Shared.JsonReply;
}

[ApiController]
public sealed class BenchController(Greeter greeter) : ControllerBase
{
    // An MVC action returning a bare string answers text/plain already; Content
    // states the media type, charset included, so the response header matches the
    // rest of the suite byte for byte and not just after the semicolon.
    [HttpGet("/plaintext")]
    public ContentResult Plaintext() => Content(greeter.Text(), "text/plain; charset=utf-8");

    [HttpGet("/json")]
    public Greeting Json() => greeter.Payload();

    [HttpGet("/params/{id}")]
    public Param Params(string id) => new(id);

    // [ApiController] validates the bound model before the action runs, which is
    // the same shape as Spring's @Valid and Nest's pipe: the framework rejects,
    // not the handler.
    [HttpPost("/validate")]
    public Echo Validate([FromBody] Person person) => new(person.Name, person.Age);
}
