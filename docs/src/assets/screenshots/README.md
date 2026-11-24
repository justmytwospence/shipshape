# Landing screenshots

Taken from the demo sandbox (`examples/demo` and `src/bin/seed-demo.ts`), whose update ids
are fixed: 2 is a decision with breaking changes, 8 a rollback. Regenerate them from the
repository root with a CDP Chrome on 9222 (see `bin/shots.mjs`) and `npm run dev:ui -- --demo`
running:

```sh
node bin/shots.mjs --out .shots/landing --vp desktop-hidpi --scheme dark  --routes '/updates/2?list=inbox' --name hero-decision-dark.png
node bin/shots.mjs --out .shots/landing --vp desktop-hidpi --scheme light --routes '/updates/2?list=inbox' --name hero-decision-light.png
node bin/shots.mjs --out .shots/landing --vp phone         --scheme light --routes '/updates/2?list=inbox' --name decision-phone-light.png
node bin/shots.mjs --out .shots/landing --vp desktop-hidpi --scheme light --routes '/updates?stage=releases' --name releases-light.png
node bin/shots.mjs --out .shots/landing --vp desktop-hidpi --scheme dark  --routes '/updates/8?list=updates&stage=all' --name rollback-dark.png
node bin/shots.mjs --out .shots/landing --vp desktop-hidpi --scheme light --routes '/updates/2?list=inbox' --before "document.getElementById('confirm-ship-2').showModal()" --name ship-confirm-light.png
node bin/shots.mjs --out .shots/landing --vp phone         --scheme dark  --routes '/' --name inbox-phone-dark.png
node bin/shots.mjs --out .shots/landing --vp desktop-hidpi --scheme light --routes '/services/nextcloud/db?list=services' --before "document.getElementById('rung-nextcloud-db').showModal()" --name service-class-light.png
cp .shots/landing/*.png docs/src/assets/screenshots/
```

Status is not in the set: in the sandbox it carries the sandbox banner, the credentials it
removed on purpose, and the local checkout path.
