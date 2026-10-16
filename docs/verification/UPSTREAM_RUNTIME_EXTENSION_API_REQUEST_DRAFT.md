# Upstream feature request draft: supported runtime extension bridge

Status: draft only. This request has not been submitted.

## Title

Add a supported, versioned extension bridge for companion UI integrations

## Body

Hello, and thank you for maintaining LilacAnime.

I am exploring an optional Companion that can show a small weekly schedule in the existing home screen without replacing the player or modifying installed application files. In an isolated copy of v0.5.14, I was able to insert and remove a synthetic schedule inside the real renderer, but only after adding a test hook to the app's main process and using its in-process Electron debugger API. That experiment demonstrates technical feasibility in a controlled copy; it does not provide a supported way for an external Companion to attach to an unmodified installation.

Would you consider a documented extension interface for narrowly scoped Companion integrations? A useful first version could provide:

- A versioned capability handshake so an extension can fail closed when the host does not support the requested contract.
- Host-owned UI extension points, such as an optional home-screen section, with explicit mount, update, and unmount lifecycle events.
- A small, schema-validated message bridge for extension data. It should not expose arbitrary renderer JavaScript evaluation or a generic unrestricted IPC channel.
- Explicit permission boundaries. Reading user profiles, accessing credentials, making provider requests, or controlling playback should not be implied by permission to add a UI section.
- Deterministic cleanup when an extension exits, is disabled, or becomes incompatible, without leaving injected UI or listeners behind.
- A compatibility test surface or fixture so extensions can verify their declared capabilities against supported host versions.

My initial use case is read-only: display a synthetic or Companion-provided weekly schedule inside an approved home-screen slot. It does not require playback control, access to existing user data, or patching `app.asar`.

The observed v0.5.14 home anchor was `#homeView` before `#scheduleSection`, but I would prefer a host-owned extension point rather than making extensions depend on DOM selectors. A capability/version contract would also let future versions reject incompatible integrations safely instead of attempting automatic insertion.

Would this fit the project's direction? If so, I would be happy to help turn the read-only schedule use case into a small contract proposal and compatibility fixture.

## Scope and non-goals

- This draft requests an upstream-supported interface; it does not recommend opening a remote debugging port.
- It does not propose modifying upstream files, replacing `app.asar`, or automatically patching installations.
- It does not request access to existing user profiles, credentials, provider content, or playback control.
- It has not been posted, and no upstream contact has been made.
