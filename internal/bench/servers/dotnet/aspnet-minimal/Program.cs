// ASP.NET Core minimal APIs on Kestrel: routes declared as lambdas, no
// controllers, no MVC pipeline. Kestrel and the endpoint router and nothing on
// top of them, which is what node-http and bun-serve are for their runtimes.
//
// Built with a plain `dotnet publish -c Release`: no ReadyToRun, no Native AOT,
// no trimming, no invariant globalization. That is what the SDK gives anyone out
// of the box rather than a benchmark build.
using Bench;

// One thread, because every other subject in this suite is single-threaded. See
// the README, "Threads".
Shared.PinToOneThread();

var builder = WebApplication.CreateBuilder(args);
// Kestrel defaults this to Environment.ProcessorCount; the harness already pins
// that to 1, and stating it here keeps the pinning readable in the subject file.
builder.WebHost.UseSockets(options => options.IOQueueCount = 1);
builder.WebHost.UseUrls(Shared.Url());
// Nothing else in this suite logs, and the hosting layer writes two Information
// entries per request. The default template suppresses these in appsettings.json;
// this is the same suppression, in the file you are reading.
builder.Logging.SetMinimumLevel(LogLevel.Warning);

var app = builder.Build();

app.MapGet("/plaintext", () => Results.Text(Shared.Plaintext));

app.MapGet("/json", () => Results.Json(Shared.JsonReply));

app.MapGet("/params/{id}", (string id) => Results.Json(new Param(id)));

// Hand-wired validation, the way bun-serve and node-http hand-wire zod: minimal
// APIs have no model-validation filter of their own. `aspnet-mvc` is the row
// where the framework does it.
app.MapPost("/validate", (Person? person) =>
    person is null || !Shared.IsValid(person)
        ? Results.Json(Shared.BadBody, statusCode: 400)
        : Results.Json(new Echo(person.Name, person.Age)));

app.Run();
