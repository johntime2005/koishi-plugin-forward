import { Context, Session, Schema, segment, Time, Dict } from 'koishi'

export interface ForwardTarget {
  platform: string
  channelId: string
  selfId: string
  guildId?: string
}

declare module 'koishi' {
  interface Channel {
    forward: ForwardTarget[]
  }
}

export interface Rule {
  source: string
  target: string
  selfId: string
  guildId?: string
}

export const Rule: Schema<Rule> = Schema.object({
  source: Schema.string().required().description('来源频道。'),
  target: Schema.string().required().description('目标频道。'),
  selfId: Schema.string().required().description('负责推送的机器人账号。'),
  guildId: Schema.string().required().description('目标频道的群组编号。'),
}).description('转发规则。')

export const name = 'forward'

export const inject = { optional: ['database'] }

export interface Config {
  mode?: 'database' | 'config'
  rules?: Rule[]
  replyTimeout?: number
}

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    mode: Schema.union([
      Schema.const('database' as const).description('数据库'),
      Schema.const('config' as const).description('配置文件'),
    ]).default('config').description('转发规则的存储方式。'),
  }),
  Schema.union([
    Schema.object({
      mode: Schema.const('config' as const),
      rules: Schema.array(Rule).description('转发规则列表。').hidden(),
    }),
    Schema.object({}),
  ] as const),
  Schema.object({
    replyTimeout: Schema.natural().role('ms').default(Time.hour).description('转发消息不再响应回复的时间。'),
  }),
] as const)

interface RelayEntry {
  platform: string
  channelId: string
  selfId: string
  guildId?: string
}

export function apply(ctx: Context, config: Config) {
  ctx.i18n.define('zh-CN', require('./locales/zh-CN'))

  const logger = ctx.logger('forward')
  const relayMap: Dict<RelayEntry> = {}

  function parseTarget(target: string): { platform: string, channelId: string } | null {
    const platforms = [...new Set(ctx.bots.map(b => b.platform))]
      .sort((a, b) => b!.length - a!.length)
    for (const p of platforms) {
      if (p && target.startsWith(p + ':')) {
        return { platform: p, channelId: target.slice(p.length + 1) }
      }
    }
    const idx = target.indexOf(':')
    if (idx < 0) return null
    return { platform: target.slice(0, idx), channelId: target.slice(idx + 1) }
  }

  function formatTarget(t: ForwardTarget): string {
    return `${t.platform}:${t.channelId}`
  }

  function findBot(platform: string): string | undefined {
    for (const bot of ctx.bots) {
      if (bot.platform === platform) return bot.selfId
    }
  }

  async function sendRelay(session: Session<never, 'forward'>, entry: RelayEntry) {
    const { author, stripped } = session
    let { content } = stripped
    if (!content) return

    try {
      const { platform, channelId, selfId, guildId } = entry
      const bot = ctx.bots[`${platform}:${selfId}`]
      if (!bot) {
        logger.warn('bot not found: %s:%s', platform, selfId)
        return
      }

      if (segment.select(stripped.content, 'at').length && session.guildId) {
        const dict = await session.bot.getGuildMemberMap(session.guildId)
        content = segment.transform(content, {
          at(attrs) {
            if (!attrs.id) return true
            return '@' + dict[attrs.id]
          },
        })
      }

      content = `${author.name}: ${content}`
      await bot.sendMessage(channelId, content, guildId).then((ids) => {
        for (const id of ids) {
          relayMap[id] = {
            platform: session.platform,
            channelId: getChannelId(session)!,
            selfId: session.selfId,
            guildId: session.guildId,
          }
          ctx.setTimeout(() => delete relayMap[id], config.replyTimeout || Time.hour)
        }
      })
    } catch (error) {
      logger.warn(error)
    }
  }

  function getChannelId(session: Session) {
    if (typeof session.channelId === 'object' && (session.channelId as any).id) {
      return (session.channelId as any).id
    }
    return session.channelId
  }

  async function getTargets(session: Session<never, 'forward'>): Promise<ForwardTarget[]> {
    if (config.mode === 'database') {
      if (session.channel && Array.isArray(session.channel.forward)) {
        return session.channel.forward
      }

      const channelId = getChannelId(session)
      if (channelId) {
        try {
          const [channel] = await ctx.database.get('channel', {
            platform: session.platform,
            id: channelId,
          }, ['forward'])
          if (channel) {
            return channel.forward || []
          }
        } catch (error) {
          logger.warn('Failed to fetch channel targets:', error)
        }
      }
      return []
    }

    return (config.rules || [])
      .filter(rule => rule.source === session.cid)
      .map(rule => {
        const parsed = parseTarget(rule.target)
        if (!parsed) return null!
        return { ...parsed, selfId: rule.selfId, guildId: rule.guildId }
      })
      .filter(Boolean)
  }

  ctx.middleware(async (session: Session<never, 'forward'>, next) => {
    const { quote = {} } = session
    const data = quote.id ? relayMap[quote.id] : undefined
    if (data) return sendRelay(session, data)

    const tasks: Promise<void>[] = []
    const targets = await getTargets(session)
    logger.debug('middleware: cid=%s targets=%o', session.cid, targets)

    for (const target of targets) {
      tasks.push(sendRelay(session, target))
    }

    const [result] = await Promise.all([next(), ...tasks])
    return result
  })

  ctx.model.extend('channel', {
    forward: { type: 'json', initial: [] },
  })

  ctx.before('attach-channel', (session, fields) => {
    fields.add('forward')
  })

  if (config.mode === 'database') {
    ctx.inject(['database'], (ctx) => {
      const cmd = ctx.command('forward', { authority: 3 })
        .alias('fwd')

      const register = (def: string, callback: (argv: { session: Session<never, 'forward'> }, ...args: any[]) => Promise<any>) => cmd
        .subcommand(def, { authority: 3, checkArgCount: true })
        .channelFields(['forward'])
        .action((argv, ...args) => {
             if (!argv.session) return
             return callback(argv as { session: Session<never, 'forward'> }, ...args)
        })

      register('.add <channel:channel>', async ({ session }, id) => {
        const parsed = parseTarget(id)
        if (!parsed) return session.text('.no-bot')
        const selfId = findBot(parsed.platform)
        if (!selfId) return session.text('.no-bot')

        const targets = await getTargets(session)
        if (targets.some(t => t.platform === parsed.platform && t.channelId === parsed.channelId)) {
          return session.text('.unchanged', [formatTarget({ ...parsed, selfId })])
        }

        const entry: ForwardTarget = { ...parsed, selfId }
        targets.push(entry)
        const channelId = getChannelId(session)
        if (channelId) {
          await ctx.database.upsert('channel', [{
            platform: session.platform,
            id: channelId,
            forward: targets,
          }], ['platform', 'id'])
        }
        return session.text('.updated', [formatTarget(entry)])
      })

      register('.remove <channel:channel>', async ({ session }, id) => {
        const parsed = parseTarget(id)
        if (!parsed) return session.text('.unchanged', [id])

        const targets = await getTargets(session)
        const index = targets.findIndex(t => t.platform === parsed.platform && t.channelId === parsed.channelId)
        if (index >= 0) {
          targets.splice(index, 1)
          const channelId = getChannelId(session)
          if (channelId) {
            await ctx.database.upsert('channel', [{
              platform: session.platform,
              id: channelId,
              forward: targets,
            }], ['platform', 'id'])
          }
          return session.text('.updated', [id])
        } else {
          return session.text('.unchanged', [id])
        }
      }).alias('forward.rm')

      register('.clear', async ({ session }) => {
        const channelId = getChannelId(session)
        if (channelId) {
          await ctx.database.upsert('channel', [{
            platform: session.platform,
            id: channelId,
            forward: [],
          }], ['platform', 'id'])
        }
        return session.text('.updated')
      })

      register('.list', async ({ session }) => {
        const targets = await getTargets(session)
        if (!targets.length) return session.text('.empty')
        return [session.text('.header'), ...targets.map(formatTarget)].join('\n')
      }).alias('forward.ls')
    })
  }
}
