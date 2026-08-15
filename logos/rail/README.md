# logos/rail/ — game-logo rail fallback assets

One transparent PNG per game in `GAMES` (lib/normalize.mjs). The listing-image compositor
composites these at the foot of the LEFT rail when a listing's set has no wordmark of its own
(`meta.setLogoAsset`, resolved in composeMetaFor). Rail-only by design — these paths never reach
the buyer-facing description HTML.

Regenerate with the prep steps below (sizes: trimmed, fit inside 600x460, PNG):

| file | source | treatment |
|---|---|---|
| pokemon.png | logos/pokemon.svg (repo) | rasterised at density 300 |
| mtg.png | logos/mtg.svg (repo) | rasterised at density 300; dark low-saturation lettering whitened (#f5f2ea) for the dark rail, the red flame M kept |
| lorcana.png | logos/lorcana.png (repo) | trimmed |
| swu.png | logos/swu.png (repo) | negate (black -> white) for the dark rail, alpha kept |
| onepiece.png | https://en.onepiece-cardgame.com/renewal/images/common/logo_op.png | negate (black -> white) for the dark rail, alpha kept |
| riftbound.png | https://cmsassets.rgpub.io/sanity/images/dsfx7636/news/23d41c7809a48a013f3d8a7204b81fb4d8bdb164-10000x4389.png (official wordmark master) | trimmed + downscaled |

Nominative use: each mark identifies the game a listed product belongs to.
