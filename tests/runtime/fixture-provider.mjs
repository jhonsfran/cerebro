import { createFixture } from "../slice-1/provider.mjs";

const fixture = await createFixture({
  directory:
    process.env.FIXTURE_DATA_DIR ?? "/tmp/cerebro-native-host-provider",
  fixtureId: process.env.FIXTURE_ID ?? "native-host",
  sha: process.env.FIXTURE_SHA ?? "dirty-checkout",
});
fixture.server.listen(8090, "0.0.0.0");
