import { PlatformExportFormat, Task } from './model'
import { PlatformOptions } from './model/platform.options.model'
import { PlatformIntegration } from './platform-integration'

import { magicToken, getCurrentMonthDatePath } from './utils'
import { endOfMonth, format, min as dateMin, parseISO, startOfMonth } from 'date-fns'
export class OTTIntegrationNew extends PlatformIntegration {
  private authorizationHeader?: string
  private username?: string
  private userId?: number

  //TODO: Hardcordiert. Hier muss auch für die Kollegen aus anderen Standorten eine möglichkeit geschaffen werden.
  WORK_LOCATION_ID = 1604387 //GERMANY ist in https://vvm.capgemini.com/lean/wsr/protected/ott/getWorkLocations/97:110:107:111:99:107
  WORK_PLACE_ID = 1604435

  public constructor(platformLink: string, options: PlatformOptions) {
    super(platformLink, options)
  }

  private attachAuthCapture(): void {
    this.page.on('request', (request) => {
      const authorization = request.headers()['authorization']

      if (authorization && request.url().includes('/lean/wsr/protected/')) {
        this.authorizationHeader = authorization
      }
    })
  }

  override async importTasks(notifyTasks?: (p: Task[]) => void): Promise<Task[]> {
    console.log('[OTT] importTasks started; platformLink:', this.platformLink)
    await this.init()
    // The auth header travels on OTT's own XHRs. init() already ran page.goto()
    // before we could listen, so those requests are missed. Reload re-fires them
    // while the capture listener is attached, so authorizationHeader is captured.
    this.attachAuthCapture()
    console.log('[OTT] reloading page to capture auth header...')
    await this.page.reload()
    await this.page.waitForSelector('[role="table"]')
    console.log('[OTT] table ready; auth header captured:', this.authorizationHeader ? 'yes' : 'NO')
    const username = await this.fetchUsernameandId()
    console.log(
      '[OTT] auth header:',
      this.authorizationHeader ? 'captured' : 'MISSING',
      '| username:',
      username,
    )
    const currentMonthDatePath = getCurrentMonthDatePath()
    const workLogData = await this.getWorkLogData(magicToken(username), currentMonthDatePath)
    console.log(
      '[OTT] datePath:',
      currentMonthDatePath,
      '| assignedIssues:',
      workLogData?.assignedIssues?.length,
      '| assoBoardProjectCodes:',
      workLogData?.assoBoardProjectCodes?.length,
    )
    const tasks = this.mapWorkLogDataToTasks(workLogData)
    console.log('[OTT] mapped tasks:', tasks.length)
    notifyTasks && notifyTasks(tasks)
    return tasks
  }

  /**
   * Retrieves the currently authenticated OTT username, it additionally sets the userId.
   *
   * @returns The login name of the currently authenticated OTT user.
   * @throws Error if no authorization header has been captured.
   * @throws Error if the request fails or the username is missing in the response.
   */
  private async fetchUsernameandId(): Promise<string> {
    if (!this.authorizationHeader) {
      throw new Error('No username captured')
    }

    const userData = await this.page.evaluate(async (auth) => {
      const response = await fetch('/lean/wsr/protected/users/data', {
        method: 'GET',
        headers: {
          authorization: auth,
        },
        credentials: 'include',
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`)
      }

      return response.json()
    }, this.authorizationHeader)

    this.username = userData?.data?.[0]?.login
    this.userId = userData?.data?.[0]?.id

    if (!this.username) {
      throw new Error('Username not found in response')
    }

    return this.username
  }

  /**
   * This method returns the given work Data that consists of the unstructured Tasks.
   * @param userNameMagic - The username in ASCII-encoding created with the name parser under tutils.
   * @param datePath - The date path created with the dateParser under utils.
   * @returns Raw work log data as type OttWorkLogData
   */
  private async getWorkLogData(userNameMagic: string, datePath: string): Promise<OttWorkLogData> {
    if (!this.authorizationHeader) {
      throw new Error('No username captured')
    }

    return this.page.evaluate(
      async ({ userNameMagic, datePath, auth }) => {
        const response = await fetch(
          `/lean/wsr/protected/ott/getMemberWorkLogData/${userNameMagic}/${userNameMagic}/${datePath}/All`,
          {
            method: 'GET',
            headers: {
              authorization: auth,
            },
            credentials: 'include',
          },
        )

        if (!response.ok) {
          throw new Error(`HTTP ${response.status} ${response.statusText}`)
        }

        const json = await response.json()
        return json.data[0]
      },
      {
        userNameMagic,
        datePath,
        auth: this.authorizationHeader,
      },
    )
  }

  /**
   * Derives the OTT date path (yyyyMMdd/yyyyMMdd) from the exported days,
   * spanning the first and last day (full months) so getMemberWorkLogData
   * returns timeEntries/assignedIssues for the relevant period — not only
   * the current month.
   */
  private datePathFromDays(days: string[]): string {
    const min = days.reduce((a, b) => (a < b ? a : b), days[0])
    const max = days.reduce((a, b) => (a > b ? a : b), days[0])

    return [
      format(startOfMonth(parseISO(min)), 'yyyyMMdd'),
      format(endOfMonth(parseISO(max)), 'yyyyMMdd'),
    ].join('/')
  }

  /**
   * Builds the lookup maps used to join assignedIssues onto
   * assoBoardProjectCodes. Keys are normalized to Number because OTT returns
   * projectCodeId / appointmentId / projectCode inconsistently typed at
   * runtime (sometimes string), while Map.get() uses strict equality.
   * This matches the old impl's `projectCodeId === +assignedIssue.projectCode`.
   */
  private buildProjectMaps(workLogData: OttWorkLogData) {
    const projectMap = new Map(
      workLogData.assoBoardProjectCodes.map((project) => [Number(project.projectCodeId), project]),
    )
    const issueMap = new Map(
      workLogData.assignedIssues.map((issue) => [Number(issue.appointmentId), issue]),
    )
    return { projectMap, issueMap }
  }

  /**
   * This method maps the raw OTT response to the internal task structure.
   * @param workLogData the raw return type from OTT
   * @returns an array of Tasks
   */
  private mapWorkLogDataToTasks(workLogData: OttWorkLogData): Task[] {
    const { projectMap } = this.buildProjectMaps(workLogData)

    return workLogData.assignedIssues.map((issue) => {
      const project = projectMap.get(Number(issue.projectCode))

      return {
        name: issue.title,
        intId: issue.appointmentId,
        projectIntId: project?.gfsProjectCode ?? 0,
        projectName: project?.gtmProjectName ?? '',
        taskCode: project?.gfsTaskCode ?? '',
        typ: 'OTT',
      } satisfies Task
    })
  }

  override async exportTasks(data: PlatformExportFormat, submitTimesheets: boolean): Promise<void> {
    // submitTimesheets wird bewusst ignoriert: OTTzTalker finalisiert nicht via API und es ist
    // kein bekannter REST-Endpunkt für Finalise.
    void submitTimesheets

    const days = Object.keys(data)
    if (days.length === 0) return

    await this.init()
    // See importTasks: reload so the auth-capture listener catches OTT's
    // authenticated requests, then wait for the table to render.
    this.attachAuthCapture()
    await this.page.reload()
    await this.page.waitForSelector('[role="table"]')

    const usernameMagic = magicToken(await this.fetchUsernameandId())
    const exportDatePath = this.datePathFromDays(days)
    console.log('[OTT] export datePath:', exportDatePath)
    const workLogData = await this.getWorkLogData(usernameMagic, exportDatePath)
    console.log(
      '[OTT] export workLogData: assignedIssues:',
      workLogData.assignedIssues.length,
      '| assoBoardProjectCodes:',
      workLogData.assoBoardProjectCodes.length,
      '| timeEntries:',
      workLogData.timeEntries.length,
    )

    const { projectMap, issueMap } = this.buildProjectMaps(workLogData)
    const existingMap = new Map(
      workLogData.timeEntries.map((te) => [`${te.appointmentId}-${te.dateLogged}`, te]),
    )

    for (const [day, entries] of Object.entries(data)) {
      const dateLogged = Number(day.replace(/-/g, ''))
      if (Number.isNaN(dateLogged)) {
        throw new Error(`Unerwarteter Day-Key im Export: '${day}' (erwartet yyyy-MM-dd)`)
      }

      for (const we of entries) {
        const issue = issueMap.get(Number(we.taskIntId))
        const resolvedBoardId = issue
          ? projectMap.get(Number(issue.projectCode))?.boardId
          : undefined
        console.log(
          `[OTT] export ${we.taskName} ${day}: issue${issue ? ' found' : ' NOT FOUND'}, ` +
            `projectCode=${issue?.projectCode}, boardId=${resolvedBoardId ?? '-'}`,
        )
        if (!issue) {
          throw new Error(`Kein OTT-Issue für taskIntId ${we.taskIntId} (${we.taskName})`)
        }
        const project = projectMap.get(Number(issue.projectCode))
        if (!project) {
          throw new Error(
            `Kein OTT-Projekt für projectCode ${issue.projectCode} (Task ${we.taskName}). ` +
              `Bekannte projectCodeIds: ${[...projectMap.keys()].join(', ')}`,
          )
        }
        if (project.boardId == null) {
          throw new Error(
            `OTT-Projekt ${issue.projectCode} (${project.gtmProjectName ?? project.gfsProjectCode}) ` +
              `hat kein boardId (Task ${we.taskName}). OTT liefert für diesen Eintrag kein boardId in ` +
              `assoBoardProjectCodes, daher kann der TimeEntry nicht via API angelegt werden.`,
          )
        }

        const existing = existingMap.get(`${we.taskIntId}-${dateLogged}`)
        let response: { status?: string; message?: string }

        if (existing && existing.hoursLogged === we.hours) {
          // Identische Stunden -> kein POST (wie OTTzTalker), aber Comment wird trotzdem gesendet.
          console.log(`Skip (Schon korrekt, ${we.hours}h): ${we.taskName} ${day}`)
          response = { status: '0' }
        } else if (existing) {
          // Update-Zweig: activityId wird NICHT gesendet (Referenz sendet es nicht,
          // da es eine bestehende activityId sonst auf null setzen würde).
          response = await this.postJson('/lean/wsr/protected/ott/updateTimeEntry', {
            id: Number(existing.id),
            appointmentId: Number(we.taskIntId),
            stickyNoteId: Number(issue.stickyNoteId),
            dateLogged,
            hoursLogged: we.hours,
            description: '',
            loggedFor: Number(this.userId),
            trackingType: 1,
            boardId: Number(project.boardId),
            engagementId: Number(issue.engagementId),
            issueName: we.taskName,
            workLocationId: this.WORK_LOCATION_ID,
            workPlaceId: this.WORK_PLACE_ID,
          })
        } else {
          // Create-Zweig
          response = await this.postJson('/lean/wsr/protected/ott/timeEntry', {
            appointmentId: Number(we.taskIntId),
            stickyNoteId: Number(issue.stickyNoteId),
            dateLogged,
            hoursLogged: we.hours,
            description: '',
            loggedFor: Number(this.userId),
            trackingType: 1,
            boardId: Number(project.boardId),
            engagementId: Number(issue.engagementId),
            issueName: we.taskName,
            activityId: null,
            workLocationId: this.WORK_LOCATION_ID,
            workPlaceId: this.WORK_PLACE_ID,
          })
        }

        if (response?.status !== '0') {
          throw new Error(
            `OTT timeEntry fehlgeschlagen für ${we.taskName} (${day}): ${JSON.stringify(response)}`,
          )
        }

        if (we.comment) {
          const commentResponse = await this.postJson(
            `/lean/wsr/protected/ott/createOrUpdateOttStickyComment/${usernameMagic}`,
            [
              {
                id: null,
                userId: Number(this.userId),
                stickyNoteId: Number(issue.stickyNoteId),
                appointmentId: Number(we.taskIntId),
                workLocationId: this.WORK_LOCATION_ID,
                workPlaceId: this.WORK_PLACE_ID,
                loggedDate: String(dateLogged),
                comment: we.comment,
              },
            ],
          )
          if (commentResponse?.status !== '0') {
            throw new Error(
              `OTT Comment fehlgeschlagen für ${we.taskName} (${day}): ${JSON.stringify(commentResponse)}`,
            )
          }
        }
      }
    }
  }

  private async postJson(
    path: string,
    body: unknown,
  ): Promise<{ status?: string; message?: string }> {
    if (!this.authorizationHeader) {
      throw new Error('No authorization header captured')
    }
    return this.page.evaluate(
      async ({ path, auth, body }) => {
        const response = await fetch(path, {
          method: 'POST',
          headers: { authorization: auth, 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(body),
        })
        return response.json()
      },
      { path, auth: this.authorizationHeader, body },
    )
  }

  override async quitBrowser(): Promise<void> {
    if (this.browser) {
      await this.browser.close()
    }
  }
}
