# Marks

Third-party and product marks, as files rather than as path data pasted into
markup.

These are NOT `brand/logos/`. That folder is the RoleModel brand family: it has
a manifest, every variant is asserted against it, and all of it is staged into
every composition. A Claude mark or a partner's logo belongs to neither of those
jobs — it is a picture the Studio's own UI draws, so it lives here and is loaded
by name:

    <rm-svg name="claude"></rm-svg>

One file per mark, named after it. The element fetches `/brand/marks/<name>.svg`
once per name however many times it appears, and inlines it so CSS can reach it.
