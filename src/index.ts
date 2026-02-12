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

  function findBot(session: Session, platform: string, channelId: string): string | undefined {
    // 如果恰好是通过同一平台的会话触发，且有 selfId，优先使用当前机器人
    if (session.platform === platform && session.selfId) {
      return session.selfId
    }

    let fallbackBot: string | undefined
    for (const bot of ctx.bots) {
      if (bot.platform === platform) {
        // 对于部分平台 (例如 minecraft)，channelId 通常等同于 bot.selfId 或是 bot.config.serverName
        if (bot.selfId === channelId || (bot as any).config?.serverName === channelId) {
          return bot.selfId
        }
        if (!fallbackBot) {
          fallbackBot = bot.selfId
        }
      }
    }
    return fallbackBot
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
    const raw = session.channelId
    if (typeof raw === 'object' && (raw as any).id) {
      return (raw as any).id
    }
    return raw || session.event?.channel?.id || session.guildId
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

    for (const target of targets) {
      tasks.push(sendRelay(session, target))
    }

    const [result] = await Promise.all([next(), ...tasks])
    return result
  })

  async function sendNotification(session: Session, text: string) {
    logger.info('[forward] sendNotification called, platform=%s, type=%s, text=%s', session.platform, session.type, text)
    logger.info('[forward] session.channelId=%s, session.guildId=%s, event.channel=%o, event.guild=%o',
      session.channelId, session.guildId, session.event?.channel, session.event?.guild)

    const channelId = getChannelId(session)
    logger.info('[forward] resolved channelId=%s', channelId)
    if (!channelId) {
      logger.warn('[forward] no channelId resolved, skipping')
      return
    }

    const cid = `${session.platform}:${channelId}`
    logger.info('[forward] cid=%s, mode=%s', cid, config.mode)
    let targets: ForwardTarget[] = []

    if (config.mode === 'database') {
      try {
        const [channel] = await ctx.database.get('channel', {
          platform: session.platform,
          id: channelId,
        }, ['forward'])
        logger.info('[forward] db query result: %o', channel)
        if (channel) {
          targets = channel.forward || []
        }
      } catch (error) {
        logger.warn('Failed to fetch channel targets:', error)
      }
    } else {
      logger.info('[forward] config rules: %o', config.rules)
      targets = (config.rules || [])
        .filter(rule => rule.source === cid)
        .map(rule => {
          const parsed = parseTarget(rule.target)
          if (!parsed) return null!
          return { ...parsed, selfId: rule.selfId, guildId: rule.guildId }
        })
        .filter(Boolean)
    }

    logger.info('[forward] resolved %d targets: %o', targets.length, targets)

    for (const target of targets) {
      try {
        const { platform, channelId: targetChannelId, selfId, guildId } = target
        const bot = ctx.bots[`${platform}:${selfId}`]
        if (!bot) {
          logger.warn('bot not found: %s:%s', platform, selfId)
          continue
        }
        logger.info('[forward] sending to %s:%s', platform, targetChannelId)
        await bot.sendMessage(targetChannelId, text, guildId)
      } catch (error) {
        logger.warn(error)
      }
    }
  }

  // 去重缓存：防止事件在 session 生命周期中多次触发导致重复通知
  const recentNotifications = new Map<string, number>()
  const NOTIFICATION_DEDUP_MS = 3000

  const handleEvent = (session: Session) => {
    logger.info('[forward] %s event received, user=%o', session.type, session.event?.user)
    const name = session.event?.user?.name || session.event?.member?.nick || session.userId
    let text: string

    switch (session.type) {
      case 'guild-member-added':
        text = `${name} 加入了服务器`
        break
      case 'guild-member-removed':
        text = `${name} 离开了服务器`
        break
      default:
        return
    }

    // 去重：同一事件在短时间窗口内只发送一次
    const dedupKey = `${session.type}:${name}:${session.event?.guild?.id || ''}`
    const now = Date.now()
    const lastSent = recentNotifications.get(dedupKey)
    if (lastSent && now - lastSent < NOTIFICATION_DEDUP_MS) {
      return
    }
    recentNotifications.set(dedupKey, now)

    // 定期清理过期条目
    if (recentNotifications.size > 100) {
      for (const [key, ts] of recentNotifications) {
        if (now - ts > NOTIFICATION_DEDUP_MS * 2) {
          recentNotifications.delete(key)
        }
      }
    }

    sendNotification(session, text)
  }

  ctx.on('guild-member-added', handleEvent)
  ctx.on('guild-member-removed', handleEvent)

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
        const selfId = findBot(session, parsed.platform, parsed.channelId)
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