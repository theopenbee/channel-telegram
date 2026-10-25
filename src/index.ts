import { defineChannel } from "@theopenbee/channel-sdk";

import { createTelegramChannel } from "./telegram.js";

defineChannel(createTelegramChannel());
