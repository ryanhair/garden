/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import chalk from "chalk"
import Bluebird from "bluebird"
import {
  ConfigGraph,
  Garden,
  GardenService,
  LogEntry,
  PluginCommand,
  PluginCommandParams,
  PluginTask,
} from "@garden-io/sdk/types"

import { PulumiModule, PulumiProvider } from "./config"
import { Profile } from "@garden-io/core/build/src/util/profiling"
import {
  cancelUpdate,
  getPreviewDirPath,
  previewStack,
  PulumiParams,
  refreshResources,
  reimportStack,
  selectStack,
} from "./helpers"
import { dedent } from "@garden-io/sdk/util/string"
import { emptyDir } from "fs-extra"
import { ModuleConfigContext } from "@garden-io/core/build/src/config/template-contexts/module"
import { deletePulumiService } from "./handlers"

interface PulumiParamsWithService extends PulumiParams {
  service: GardenService
}

type PulumiRunFn = (params: PulumiParamsWithService) => Promise<void>

interface PulumiCommandSpec {
  name: string
  commandDescription: string
  beforeFn?: ({ ctx: PluginContext, log: LogEntry }) => Promise<void>
  runFn: PulumiRunFn
}

const pulumiCommandSpecs: PulumiCommandSpec[] = [
  {
    name: "preview",
    commandDescription: "pulumi preview",
    beforeFn: async ({ ctx, log }) => {
      const previewDirPath = getPreviewDirPath(ctx)
      // We clear the preview dir, so that it contains only the plans generated by this preview command.
      log.info(`Clearing preview dir at ${previewDirPath}...`)
      await emptyDir(previewDirPath)
    },
    runFn: async (params) => {
      const { ctx } = params
      const previewDirPath = getPreviewDirPath(ctx)
      await previewStack({ ...params, logPreview: true, previewDirPath })
    },
  },
  {
    name: "cancel",
    commandDescription: "pulumi cancel",
    runFn: async (params) => await cancelUpdate(params),
  },
  {
    name: "refresh",
    commandDescription: "pulumi refresh",
    runFn: async (params) => await refreshResources(params),
  },
  {
    name: "reimport",
    commandDescription: "pulumi export | pulumi import",
    runFn: async (params) => await reimportStack(params),
  },
  {
    name: "destroy",
    commandDescription: "pulumi destroy",
    runFn: async (params) => {
      if (params.module.spec.allowDestroy) {
        await deletePulumiService(params)
      }
    },
  },
]

interface PulumiPluginCommandTaskParams {
  garden: Garden
  graph: ConfigGraph
  log: LogEntry
  service: GardenService
  commandName: string
  commandDescription: string
  runFn: PulumiRunFn
  pulumiParams: PulumiParamsWithService
}

@Profile()
class PulumiPluginCommandTask extends PluginTask {
  graph: ConfigGraph
  pulumiParams: PulumiParamsWithService
  service: GardenService
  commandName: string
  commandDescription: string
  runFn: PulumiRunFn

  constructor({
    garden,
    graph,
    log,
    service,
    commandName,
    commandDescription,
    runFn,
    pulumiParams,
  }: PulumiPluginCommandTaskParams) {
    super({ garden, log, force: false, version: service.version })
    this.graph = graph
    this.service = service
    this.commandName = commandName
    this.commandDescription = commandDescription
    this.runFn = runFn
    this.pulumiParams = pulumiParams
    const provider = <PulumiProvider>pulumiParams.ctx.provider
    this.concurrencyLimit = provider.config.pluginTaskConcurrencyLimit
  }

  getName() {
    return this.service.name
  }

  getDescription(): string {
    return `running ${chalk.white(this.commandName)} for ${this.service.name}`
  }

  async resolveDependencies(): Promise<PluginTask[]> {
    const pulumiServiceNames = this.graph
      .getModules()
      .filter((m) => m.type === "pulumi")
      .map((m) => m.name) // module names are the same as service names for pulumi modules
    const deps = this.graph.getDependencies({
      nodeType: "deploy",
      name: this.getName(),
      recursive: false,
      filter: (depNode) => pulumiServiceNames.includes(depNode.name),
    })
    return deps.deploy.map((depService) => {
      return new PulumiPluginCommandTask({
        garden: this.garden,
        graph: this.graph,
        log: this.log,
        service: depService,
        commandName: this.commandName,
        commandDescription: this.commandDescription,
        runFn: this.runFn,
        pulumiParams: { ...this.pulumiParams, module: depService.module },
      })
    })
  }

  async process(): Promise<{}> {
    const log = this.log.info({
      section: this.getName(),
      msg: chalk.gray(`Running ${chalk.white(this.commandDescription)}`),
      status: "active",
    })
    try {
      await selectStack(this.pulumiParams)
      await this.runFn(this.pulumiParams)
    } catch (err) {
      log.setError({
        msg: chalk.red(`Failed! (took ${log.getDuration(1)} sec)`),
      })
      throw err
    }
    log.setSuccess({
      msg: chalk.green(`Success (took ${log.getDuration(1)} sec)`),
    })
    return {}
  }
}

export const getPulumiCommands = (): PluginCommand[] => pulumiCommandSpecs.map(makePulumiCommand)

function makePulumiCommand({ name, commandDescription, beforeFn, runFn }: PulumiCommandSpec) {
  const description = commandDescription || `pulumi ${name}`
  const pulumiCommand = chalk.bold(description)

  return {
    name,
    description: dedent`
      Runs ${pulumiCommand} for the specified pulumi services, in dependency order (or for all pulumi services if no
      service names are provided).
    `,
    // We don't want to call `garden.getConfigGraph` twice (we need to do it in the handler anyway)
    resolveModules: false,

    title: ({ args }) =>
      chalk.bold.magenta(`Running ${chalk.white.bold(pulumiCommand)} for module ${chalk.white.bold(args[0] || "")}`),

    async handler({ garden, ctx, args, log }: PluginCommandParams) {
      const serviceNames = args.length === 0 ? undefined : args
      const graph = await garden.getConfigGraph({ log, emit: false })

      if (beforeFn) {
        await beforeFn({ ctx, log })
      }

      const allProviders = await garden.resolveProviders(log)
      const allModules = graph.getModules()

      const provider = ctx.provider as PulumiProvider
      const services = graph.getServices({ names: serviceNames }).filter((s) => s.module.type === "pulumi")

      const tasks = await Bluebird.map(services, async (service) => {
        const templateContext = ModuleConfigContext.fromModule({
          garden,
          resolvedProviders: allProviders,
          module: service.module,
          modules: allModules,
          partialRuntimeResolution: false,
        })
        const ctxForModule = await garden.getPluginContext(provider, templateContext, ctx.events)
        const pulumiParams: PulumiParamsWithService = {
          ctx: ctxForModule,
          provider,
          log,
          module: <PulumiModule>service.module,
          service,
        }
        // TODO: Generate a non-empty runtime context to provide runtime values for template resolution in varfiles.
        // This will require processing deploy & task dependencies (also for non-pulumi modules).
        return new PulumiPluginCommandTask({
          garden,
          graph,
          log,
          service,
          commandName: name,
          commandDescription,
          runFn,
          pulumiParams,
        })
      })

      await garden.processTasks(tasks)

      return { result: {} }
    },
  }
}
