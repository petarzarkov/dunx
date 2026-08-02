# Should @dunx/auth be @dunx/better-auth

**Open. Offered once, never answered.**

`@dunx/auth` is better-auth and nothing else: the module, the mount, the guard, two
Bun-native adapters, and none of the auth flow itself. The name suggests dunx has an
opinion about authentication in general, when the opinion is precisely "use
better-auth".

Renaming would make the dependency legible from the install line, the same way
`@dunx/transform` now says what it does where `@dunx/compiler` overstated it.

**The window has closed on doing it for free.** `@dunx/auth@0.1.0` and `0.1.1` are
published. A rename now means deprecating the old name and publishing under a new
one, which is a real cost for a naming preference. Worth deciding deliberately
rather than by default.
