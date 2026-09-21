import { PlatformExportFormat, Task } from './model'
import { PlatformOptions } from './model/platform.options.model'
import { PlatformIntegration } from './platform-integration'

import { magicToken, getCurrentMonthDatePath } from './utils'
import {
  eachDayOfInterval,
  endOfMonth,
  format,
  max as dateMax,
  min as dateMin,
  parseISO,
  startOfMonth,
} from 'date-fns'
export class OTTIntegration extends PlatformIntegration {
  private authorizationHeader?: string
  private username?: string
  private userId?: number

  //TODO: Hardcordiert.
  WORK_LOCATION_ID = 1604387 //GERMANY ist in /lean/wsr/protected/ott/getWorkLocations/USRID
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
    this.attachAuthCapture()
    await this.page.reload()
    await this.page.waitForSelector('[role="table"]')
    const username = await this.fetchUsernameandId()
    const currentMonthDatePath = getCurrentMonthDatePath()
    const workLogData = await this.getWorkLogData(magicToken(username), currentMonthDatePath)

    const tasks = this.mapWorkLogDataToTasks(workLogData)
    notifyTasks && notifyTasks(tasks)
    return tasks
  }

    override async quitBrowser(): Promise<void> {
    if (this.browser) {
      await this.browser.close()
    }
  }

   override async exportTasks(data: PlatformExportFormat, submitTimesheets: boolean): Promise<void> {
    // Submit Timesheets is not done. It is not nessecary. 
    void submitTimesheets

    const days = Object.keys(data)
    if (days.length === 0) return

    await this.init()
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

    const parsedDays = days.map((day) => parseISO(day))
    const exportDays = new Set(
      eachDayOfInterval({ start: dateMin(parsedDays), end: dateMax(parsedDays) }).map((d) =>
        Number(format(d, 'yyyyMMdd')),
      ),
    )
    const desiredKeys = new Set<string>()
    for (const [day, entries] of Object.entries(data)) {
      const dateLogged = Number(day.replace(/-/g, ''))
      for (const we of entries) {
        desiredKeys.add(`${we.taskIntId}-${dateLogged}`)
      }
    }

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
    await this.deleteStaleTimeEntries(workLogData, exportDays, desiredKeys)
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
   * Derives the OTT date path (yyyyMMdd/yyyyMMdd) from the exported days.
   */
  private datePathFromDays(days: string[]): string {
    const min = days.reduce((a, b) => (a < b ? a : b), days[0])
    const max = days.reduce((a, b) => (a > b ? a : b), days[0])

    return [
      format(startOfMonth(parseISO(min)), 'yyyyMMdd'),
      format(endOfMonth(parseISO(max)), 'yyyyMMdd'),
    ].join('/')
  }

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

 
/** 
   *
   * @param workLogData - der vom OTT gelieferte Bestand (Quelle der zu räumenden Einträge)
   * @param exportDays - der exportierte Tagbereich (leere Tage eingeschlossen)
   * @param desiredKeys - die (taskIntId,Tag)-Kombis, die in Zedd bleiben sollen
   */
  private async deleteStaleTimeEntries(
    workLogData: OttWorkLogData,
    exportDays: Set<number>,
    desiredKeys: Set<string>,
  ): Promise<void> {
    const toDelete: Array<{
      id: number
      appointmentId: number
      stickyNoteId: number
      dateLogged: number
      hoursLogged: number
      description: string
      loggedFor: number
      trackingType: number
      boardId: number
      engagementId: number
      originalValues: Record<string, string | number>
      workLocationId: number
      workPlaceId: number
      reason: string
    }> = []
    for (const te of workLogData.timeEntries) {
      if (!exportDays.has(Number(te.dateLogged))) continue
      const key = `${te.appointmentId}-${Number(te.dateLogged)}`
      if (desiredKeys.has(key)) continue
      if (Number(te.hoursLogged) === 0) continue
      const dateLogged = Number(te.dateLogged)
      const hoursLogged = Number(te.hoursLogged)
      const loggedFor = Number(te.loggedFor) || Number(this.userId)
      toDelete.push({
        id: Number(te.id),
        appointmentId: Number(te.appointmentId),
        stickyNoteId: Number(te.stickyNoteId),
        dateLogged,
        hoursLogged,
        description: te.description ?? '',
        loggedFor,
        trackingType: Number(te.trackingType),
        boardId: Number(te.boardId),
        engagementId: Number(te.engagementId),
        // "Issue Id" ist die stickyNoteId (siehe OTT-Referenz-Payload).
        originalValues: {
          'Issue Name': te.issueName,
          'Issue Id': Number(te.stickyNoteId),
          Date: dateLogged,
          Duration: hoursLogged,
          Description: te.description ?? '',
          'Logged For': loggedFor,
          'Work Location': this.WORK_LOCATION_ID,
          'Place of Work': this.WORK_PLACE_ID,
        },
        workLocationId: this.WORK_LOCATION_ID,
        workPlaceId: this.WORK_PLACE_ID,
        reason: 'Time booking adjustment.',
      })
    }
    if (toDelete.length === 0) return
    console.log(
      `[OTT] Reconciliation: lösche insgesamt ${toDelete.length} verwaiste(n) OTT-Eintrag(e).`,
    )
    const response = await this.deleteJson('/lean/wsr/protected/ott/deleteTimeEntry', toDelete)
    if (response?.status !== '0') {
      throw new Error(
        `OTT Reconciliation (deleteTimeEntry) fehlgeschlagen: ${JSON.stringify(response)}`,
      )
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

  private async deleteJson(
    path: string,
    body: unknown,
  ): Promise<{ status?: string; message?: string }> {
    if (!this.authorizationHeader) {
      throw new Error('No authorization header captured')
    }
    return this.page.evaluate(
      async ({ path, auth, body }) => {
        const response = await fetch(path, {
          method: 'DELETE',
          headers: { authorization: auth, 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(body),
        })
        const text = await response.text()
        if (!text) {
          return { status: response.ok ? '0' : String(response.status), message: '' }
        }
        try {
          return JSON.parse(text)
        } catch {
          return { status: response.ok ? '0' : String(response.status), message: text }
        }
      },
      { path, auth: this.authorizationHeader, body },
    )
  }


}
