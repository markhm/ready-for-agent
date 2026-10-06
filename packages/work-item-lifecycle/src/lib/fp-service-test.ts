import type { Layer } from "effect"
import {
  type FpService,
  type FpServiceTestFixture,
  makeFpServiceTest,
} from "@ready-for-agent/fp-service"

/** In-memory fp for lifecycle tests: no fp CLI is ever spawned. */
export const stubFpServiceLayer = (
  fixture: FpServiceTestFixture = {},
): Layer.Layer<FpService> => makeFpServiceTest(fixture)
