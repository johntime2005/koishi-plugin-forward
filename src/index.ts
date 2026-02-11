import { Context, Session, Schema, segment, Time, Dict } from 'koishi'

declare module 'koishi' {
  interface Channel {
    forward: string[]
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

export function apply(ctx: Context, config: Config) {
  ctx.i18n.define('zh-CN', require('./locales/zh-CN'))

  const relayMap: Dict<Rule> = {}

  async function sendRelay(session: Session<never, 'forward'>, rule: Partial<Rule>) {
    const { author, stripped } = session
    let { content } = stripped
    if (!content) return

    try {
      if (!rule.target) return
      const platform = rule.target.split(':', 1)[0]
      const channelId = rule.target.slice(platform.length + 1)
      if (!rule.selfId) {
        const channel = await ctx.database.getChannel(platform, channelId, ['assignee', 'guildId'])
        if (!channel || !channel.assignee) return
        rule.selfId = channel.assignee
        rule.guildId = channel.guildId
      }

      const bot = ctx.bots[`${platform}:${rule.selfId}`]

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
      await bot.sendMessage(channelId, content, rule.guildId).then((ids) => {
        for (const id of ids) {
          relayMap[id] = {
            source: rule.target!,
            target: session.cid,
            selfId: session.selfId,
            guildId: session.guildId,
          }
          ctx.setTimeout(() => delete relayMap[id], config.replyTimeout || Time.hour)
        }
      })
    } catch (error) {
      ctx.logger('forward').warn(error)
    }
  }

  function getChannelId(session: Session) {
    if (typeof session.channelId === 'object' && (session.channelId as any).id) {
      return (session.channelId as any).id
    }
    return session.channelId
  }

  async function getTargets(session: Session<never, 'forward'>) {
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
          ctx.logger('forward').warn('Failed to fetch channel targets:', error)
        }
      }
      return []
    }

    return (config.rules || [])
      .filter(rule => rule.source === session.cid)
      .map(rule => rule.target)
  }

  ctx.middleware(async (session: Session<never, 'forward'>, next) => {
    const { quote = {}, isDirect } = session
    if (isDirect) return next()
    const data = quote.id ? relayMap[quote.id] : undefined
    if (data) return sendRelay(session, data)

    const tasks: Promise<void>[] = []
    const targets = await getTargets(session)
    
    for (const target of targets) {
      tasks.push(sendRelay(session, { target }))
    }
    
    const [result] = await Promise.all([next(), ...tasks])
    return result
  })

  ctx.model.extend('channel', {
    forward: 'list',
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
        const targets = await getTargets(session)
        if (targets.includes(id)) {
          return session.text('.unchanged', [id])
        } else {
          targets.push(id)
          const channelId = getChannelId(session)
          if (channelId) {
              await ctx.database.setChannel(session.platform, channelId, { forward: targets })
          }
          return session.text('.updated', [id])
        }
      })

      register('.remove <channel:channel>', async ({ session }, id) => {
        const targets = await getTargets(session)
        const index = targets.indexOf(id)
        if (index >= 0) {
          targets.splice(index, 1)
          const channelId = getChannelId(session)
          if (channelId) {
              await ctx.database.setChannel(session.platform, channelId, { forward: targets })
          }
          return session.text('.updated', [id])
        } else {
          return session.text('.unchanged', [id])
        }
      }).alias('forward.rm')

      register('.clear', async ({ session }) => {
        const channelId = getChannelId(session)
        if (channelId) {
            await ctx.database.setChannel(session.platform, channelId, { forward: [] })
        }
        return session.text('.updated')
      })

      register('.list', async ({ session }) => {
        const targets = await getTargets(session)
        if (!targets.length) return session.text('.empty')
        return [session.text('.header'), ...targets].join('\n')
      }).alias('forward.ls')
    })
  }
}
