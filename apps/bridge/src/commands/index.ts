import type { Command } from "../usage.js";
import { boostsCommand } from "./boosts.js";
import { browserGroup } from "./browser.js";
import { jobCommand } from "./job.js";
import { sweepCommand } from "./sweep.js";
import {
  checkCommand,
  crawlCommand,
  findCommand,
  scrapeCommand,
  searchCommand,
  syncCommand,
  urlMapCommand,
} from "./crawl.js";
import { mapGroup } from "./site-map.js";
import { keepGroup } from "./site-keep.js";
import { blockGroup } from "./block-sites.js";
import { signinCommand } from "./signin.js";
import { packCommand } from "./pack.js";
import { useGroup } from "./site-use.js";
import { siteToolsCommand } from "./site-tools.js";
import { capabilitiesCommand } from "./capabilities.js";
import { abilitiesAliasCommand, abilitiesCommand } from "./abilities.js";
import { updateCommand } from "./update.js";
import { workflowCommand } from "./workflow.js";
import { recipeCommand } from "./recipe.js";
import { cookiesCommand } from "./cookies.js";
import { networkCommand } from "./network.js";
import { sessionCommand } from "./session.js";
import { commandsCommand } from "./help.js";
import { tabGroupsCommand, windowsCommand, zoomCommand } from "./windows.js";
import { recordCommand } from "./record.js";
import { askCommand, providersCommand } from "./ask.js";
import { mediaCommand } from "./media.js";
import { dnsCommand } from "./dns.js";
import { profileCommand } from "./profile.js";
import { cdpCommand } from "./cdp.js";

// Every capability the MCP tools and the bundled packages have, as a command.
export const COMMANDS: Command[] = [
  ...browserGroup,
  sweepCommand,
  jobCommand,
  crawlCommand,
  checkCommand,
  scrapeCommand,
  urlMapCommand,
  searchCommand,
  findCommand,
  syncCommand,
  ...mapGroup,
  ...useGroup,
  siteToolsCommand,
  capabilitiesCommand,
  abilitiesCommand,
  abilitiesAliasCommand,
  updateCommand,
  recipeCommand,
  ...keepGroup,
  ...blockGroup,
  signinCommand,
  boostsCommand,
  packCommand,
  workflowCommand,
  cookiesCommand,
  networkCommand,
  sessionCommand,
  windowsCommand,
  tabGroupsCommand,
  zoomCommand,
  recordCommand,
  askCommand,
  providersCommand,
  mediaCommand,
  dnsCommand,
  profileCommand,
  cdpCommand,
  commandsCommand,
];
