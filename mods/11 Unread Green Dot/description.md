# Mod 11: Unread Green Dot

## What It Does

Changes the "this session has unread results" indicator from solid iOS blue (`#007AFF`) to solid iOS green (`#34C759`) — the same green already used elsewhere in the app for `waiting` state and other "success" affordances. Always on, no toggle.

Upstream colors the unread dot blue, which collides with the `thinking` state (also blue, pulsing). With this mod the unread dot is unambiguously distinct from any other dot variant:

- 🔵 **Blue pulsing** — `thinking`
- 🟠 **Orange pulsing** — `permission_required`
- 🟢 **Green solid** — `hasUnread` (any state) *(was 🔵 blue solid)*
- ⚪ **Gray static** — `waiting` (no draft, not unread)
- (no indicator) — `disconnected`, or `waiting` with a draft (replaced by a pencil)

## Changes

### 1. `packages/happy-app/sources/components/ActiveSessionsGroupCompact.tsx`

The `CompactSessionRow` overrides its status when `session.hasUnread` is true. Swap the blue literal for the green literal:

```diff
-    // Override to solid blue when session has unread results
+    // Mod 11: use the same green (#34C759) as the rest of the app for unread results,
+    // not the iOS blue that overlaps with the `thinking` state.
     const status = session.hasUnread
-        ? { ...baseStatus, color: '#007AFF', dotColor: '#007AFF', isPulsing: false, isConnected: baseStatus.isConnected }
+        ? { ...baseStatus, color: '#34C759', dotColor: '#34C759', isPulsing: false, isConnected: baseStatus.isConnected }
         : baseStatus;
```

### 2. `packages/happy-app/sources/components/SessionsList.tsx`

Same override exists for the non-compact session row (~line 363). Apply the identical swap.

## Why Not Upstream

A small visual preference. Upstream's blue is defensible — blue means "new" in many UIs — but in this codebase blue is already overloaded with the active-thinking pulse, so a separate hue reads cleaner.

## Rebase Notes

- Only two literal-color sites. If upstream introduces new unread-aware rows, search for `color: '#007AFF', dotColor: '#007AFF'` and swap any matches.
- If upstream replaces the literal with a theme variable (e.g. `theme.colors.status.unread`), prefer to add a `unread` colour to the theme rather than re-introducing the literal.
