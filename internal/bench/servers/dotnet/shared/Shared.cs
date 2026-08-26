using System.ComponentModel.DataAnnotations;

namespace Bench;

/// <summary>
/// The payload shapes, the validator and the thread pinning every .NET subject
/// uses, so minimal APIs and MVC differ only in the framework and not in the work.
/// </summary>
public static class Shared
{
    public const string Plaintext = "Hello, World!";

    public static readonly Greeting JsonReply = new(Plaintext);

    public static readonly Invalid BadBody = new("Invalid body");

    /// <summary>Reads PORT the way every other subject in the suite does.</summary>
    public static string Url()
    {
        var port = Environment.GetEnvironmentVariable("PORT");
        return $"http://127.0.0.1:{(string.IsNullOrEmpty(port) ? "0" : port)}";
    }

    /// <summary>
    /// One thread, the .NET counterpart of runtime.GOMAXPROCS(1) and tokio's
    /// current_thread flavour. The harness starts the process with
    /// DOTNET_PROCESSOR_COUNT=1, which is what sizes the GC heaps and the thread
    /// pool's defaults; this caps the pool outright on top of it. Throwing is the
    /// point: measured on 32 cores, an unpinned aspnet-minimal serves 377k req/s
    /// against 88k pinned, so a subject that silently kept them would be ranking
    /// the machine.
    /// </summary>
    public static void PinToOneThread()
    {
        if (Environment.ProcessorCount != 1)
        {
            throw new InvalidOperationException(
                $"ProcessorCount is {Environment.ProcessorCount}, so this subject would not be single-threaded. "
                    + "Start it with DOTNET_PROCESSOR_COUNT=1.");
        }

        ThreadPool.SetMinThreads(1, 1);
        if (!ThreadPool.SetMaxThreads(1, 1))
        {
            throw new InvalidOperationException("Could not cap the thread pool at one worker thread.");
        }
    }

    public static bool IsValid(Person person) =>
        Validator.TryValidateObject(person, new ValidationContext(person), null, validateAllProperties: true);
}

public sealed record Greeting(string Message);

public sealed record Param(string Id);

public sealed record Echo(string Name, int Age);

public sealed record Invalid(string Error);

/// <summary>
/// The same rules as the zod schema in servers/shared.ts, written with the
/// in-box DataAnnotations attributes. The email rule is DataAnnotations' own,
/// not zod's, which is the one place the schemas differ.
/// </summary>
public sealed class Person
{
    [Required]
    [MinLength(1)]
    public string Name { get; init; } = "";

    [Range(0, int.MaxValue)]
    public int Age { get; init; }

    [Required]
    [EmailAddress]
    public string Email { get; init; } = "";
}
