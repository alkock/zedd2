import { PlatformExportFormat, Task } from './model'
import { PlatformOptions } from './model/platform.options.model'
import { WorkEntry } from './model/work-entry.model'
import {
  OttAssignedIssue,
  OttDeleteTimeEntry,
  OttExportMaps,
  OttProjectCode,
  OttTimeEntry,
  OttWorkLogData,
} from './model/ott-work-log.model'
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

  /**
   * Exports the given time entries to OTT and reconciles the result against what
   * OTT currently holds. 
   * */
  override async exportTasks(data: PlatformExportFormat, submitTimesheets: boolean): Promise<void> {
    // OTT has no separate "submit timesheet" step, so the flag has no effect here.
    void submitTimesheets

    const days = Object.keys(data)
    if (days.length === 0) return

    // Phase 1 – open the browser and authenticate.
    await this.login()

    // Phase 2 – load the current OTT work log for the exported date range.
    const usernameMagic = magicToken(await this.fetchUsernameandId())
    const workLogData = await this.fetchWorkLog(usernameMagic, days)

    // Phase 3 – index OTT data so export entries can be resolved against it.
    const maps = this.buildExportMaps(workLogData)
    const exportDays = this.exportedDays(days)
    const desiredKeys = this.desiredTimeEntryKeys(data)

    // Phase 4 – create/update/skip each time entry and apply its comment.
    await this.applyTimeEntries(data, maps, usernameMagic)

    // Phase 5 – delete OTT entries that are no longer part of the export.
    await this.deleteStaleTimeEntries(workLogData, exportDays, desiredKeys)
  }

  /**
   * Opens the OTT browser session and waits until the logged-in work log table is
   * rendered so the captured authorization header can be reused for API calls.
   */
  private async login(): Promise<void> {
    await this.init()
    this.attachAuthCapture()
    await this.page.reload()
    await this.page.waitForSelector('[role="table"]')
  }

  /**
   * Fetches the raw OTT work log covering the given days and logs the resulting sizes.
   */
  private async fetchWorkLog(usernameMagic: string, days: string[]): Promise<OttWorkLogData> {
    const datePath = this.datePathFromDays(days)
    console.log('[OTT] export datePath:', datePath)
    const workLogData = await this.getWorkLogData(usernameMagic, datePath)
    console.log(
      '[OTT] export workLogData: assignedIssues:',
      workLogData.assignedIssues.length,
      '| assoBoardProjectCodes:',
      workLogData.assoBoardProjectCodes.length,
      '| timeEntries:',
      workLogData.timeEntries.length,
    )
    return workLogData
  }

  /**
   * Builds the lookups used to resolve export entries against OTT data:
   * issues by appointmentId, projects by projectCodeId, and existing time entries
   * by `${appointmentId}-${dateLogged}`.
   */
  private buildExportMaps(workLogData: OttWorkLogData): OttExportMaps {
    const { projectMap, issueMap } = this.buildProjectMaps(workLogData)
    const existingMap = new Map(
      workLogData.timeEntries.map((te) => [`${te.appointmentId}-${te.dateLogged}`, te]),
    )
    return { projectMap, issueMap, existingMap }
  }

  /**
   * Every calendar day inside the exported range, including empty days in between
   * (used to scope reconciliation to the days actually exported).
   */
  private exportedDays(days: string[]): Set<number> {
    const parsedDays = days.map((day) => parseISO(day))
    return new Set(
      eachDayOfInterval({ start: dateMin(parsedDays), end: dateMax(parsedDays) }).map((d) =>
        Number(format(d, 'yyyyMMdd')),
      ),
    )
  }

  /**
   * The `${taskIntId}-${dateLogged}` keys of every entry in the export – the set of
   * time entries that should remain in OTT after reconciliation.
   */
  private desiredTimeEntryKeys(data: PlatformExportFormat): Set<string> {
    const desiredKeys = new Set<string>()
    for (const [day, entries] of Object.entries(data)) {
      const dateLogged = Number(day.replace(/-/g, ''))
      for (const we of entries) {
        desiredKeys.add(`${we.taskIntId}-${dateLogged}`)
      }
    }
    return desiredKeys
  }

  /**
   * Applies every exported work entry to OTT, entry by entry, in date order.
   */
  private async applyTimeEntries(
    data: PlatformExportFormat,
    maps: OttExportMaps,
    usernameMagic: string,
  ): Promise<void> {
    for (const [day, entries] of Object.entries(data)) {
      const dateLogged = Number(day.replace(/-/g, ''))
      if (Number.isNaN(dateLogged)) {
        throw new Error(`Unerwarteter Day-Key im Export: '${day}' (erwartet yyyy-MM-dd)`)
      }
      for (const we of entries) {
        await this.applyWorkEntry(we, day, dateLogged, maps, usernameMagic)
      }
    }
  }

  /**
   * Resolves the OTT issue/project for a single export entry, syncs its time entry
   * (create, update or skip), and writes its comment.
   */
  private async applyWorkEntry(
    we: WorkEntry,
    day: string,
    dateLogged: number,
    maps: OttExportMaps,
    usernameMagic: string,
  ): Promise<void> {
    const { issue, project } = this.resolveIssueAndProject(we, maps)
    const existing = maps.existingMap.get(`${we.taskIntId}-${dateLogged}`)

    await this.syncTimeEntry(we, day, dateLogged, issue, project, existing)
    await this.writeComment(we, day, dateLogged, issue, usernameMagic)
  }

  /**
   * Resolves the OTT issue and its project for an export entry, failing with a
   * descriptive error if either cannot be found or the project has no boardId.
   */
  private resolveIssueAndProject(we: WorkEntry, maps: OttExportMaps):
    { issue: OttAssignedIssue; project: OttProjectCode } {
    const issue = maps.issueMap.get(Number(we.taskIntId))
    const resolvedBoardId = issue ? maps.projectMap.get(Number(issue.projectCode))?.boardId : undefined
    console.log(
      `[OTT] export ${we.taskName} ${we.id}: issue${issue ? ' found' : ' NOT FOUND'}, ` +
        `projectCode=${issue?.projectCode}, boardId=${resolvedBoardId ?? '-'}`,
    )
    if (!issue) {
      throw new Error(`Kein OTT-Issue für taskIntId ${we.taskIntId} (${we.taskName})`)
    }
    const project = maps.projectMap.get(Number(issue.projectCode))
    if (!project) {
      throw new Error(
        `Kein OTT-Projekt für projectCode ${issue.projectCode} (Task ${we.taskName}). ` +
          `Bekannte projectCodeIds: ${[...maps.projectMap.keys()].join(', ')}`,
      )
    }
    if (project.boardId == null) {
      throw new Error(
        `OTT-Projekt ${issue.projectCode} (${project.gtmProjectName ?? project.gfsProjectCode}) ` +
          `hat kein boardId (Task ${we.taskName}). OTT liefert für diesen Eintrag kein boardId in ` +
          `assoBoardProjectCodes, daher kann der TimeEntry nicht via API angelegt werden.`,
      )
    }
    return { issue, project }
  }

  /**
   * Syncs the time entry for an export entry: skips it when OTT already holds the
   * same hours, updates it when it exists with different hours, otherwise creates it.
   */
  private async syncTimeEntry(
    we: WorkEntry,
    day: string,
    dateLogged: number,
    issue: OttAssignedIssue,
    project: OttProjectCode,
    existing: OttTimeEntry | undefined,
  ): Promise<void> {
    // Identische Stunden -> kein POST (wie OTTzTalker), aber Comment wird trotzdem gesendet.
    if (existing && existing.hoursLogged === we.hours) {
      console.log(`Skip (Schon korrekt, ${we.hours}h): ${we.taskName} ${day}`)
      return
    }

    // Update-Zweig: activityId wird NICHT gesendet (Referenz sendet es nicht,
    // da es eine bestehende activityId sonst auf null setzen würde).
    const response = existing
      ? await this.apiRequest('POST', '/lean/wsr/protected/ott/updateTimeEntry', {
          id: Number(existing.id),
          ...this.timeEntryPayload(we, dateLogged, issue, project),
        })
      : await this.apiRequest('POST', '/lean/wsr/protected/ott/timeEntry', {
          activityId: null,
          ...this.timeEntryPayload(we, dateLogged, issue, project),
        })

    if (response?.status !== '0') {
      throw new Error(
        `OTT timeEntry fehlgeschlagen für ${we.taskName} (${day}): ${JSON.stringify(response)}`,
      )
    }
  }

  /**
   * The payload shared by the create and update time-entry requests.
   */
  private timeEntryPayload(
    we: WorkEntry,
    dateLogged: number,
    issue: OttAssignedIssue,
    project: OttProjectCode,
  ) {
    return {
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
    }
  }

  /**
   * Writes the comment for an export entry to OTT (no-op when there is none).
   */
  private async writeComment(
    we: WorkEntry,
    day: string,
    dateLogged: number,
    issue: OttAssignedIssue,
    usernameMagic: string,
  ): Promise<void> {
    if (!we.comment) return

    const commentResponse = await this.apiRequest(
      'POST',
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
   * Deletes every OTT time entry that lies inside the exported date range but is
   * not part of the export anymore (stale entries), in a single batched request.
   * @param workLogData - der vom OTT gelieferte Bestand (Quelle der zu räumenden Einträge)
   * @param exportDays - der exportierte Tagbereich (leere Tage eingeschlossen)
   * @param desiredKeys - die (taskIntId,Tag)-Kombis, die in Zedd bleiben sollen
   */
  private async deleteStaleTimeEntries(
    workLogData: OttWorkLogData,
    exportDays: Set<number>,
    desiredKeys: Set<string>,
  ): Promise<void> {
    const toDelete = this.staleTimeEntries(workLogData, exportDays, desiredKeys)
    if (toDelete.length === 0) return

    console.log(
      `[OTT] Reconciliation: lösche insgesamt ${toDelete.length} verwaiste(n) OTT-Eintrag(e).`,
    )
    const response = await this.apiRequest(
      'DELETE',
      '/lean/wsr/protected/ott/deleteTimeEntry',
      toDelete.map((te) => this.buildDeleteEntry(te)),
    )
    if (response?.status !== '0') {
      throw new Error(
        `OTT Reconciliation (deleteTimeEntry) fehlgeschlagen: ${JSON.stringify(response)}`,
      )
    }
  }

  /**
   * The OTT time entries that are stale: inside the exported date range, no longer
   * part of the export, and with a non-zero duration (zero-hour entries are left
   * untouched, as OTT uses them as markers).
   */
  private staleTimeEntries(
    workLogData: OttWorkLogData,
    exportDays: Set<number>,
    desiredKeys: Set<string>,
  ): OttTimeEntry[] {
    return workLogData.timeEntries.filter((te) => {
      const dateLogged = Number(te.dateLogged)
      if (!exportDays.has(dateLogged)) return false
      if (desiredKeys.has(`${te.appointmentId}-${dateLogged}`)) return false
      return Number(te.hoursLogged) !== 0
    })
  }

  /**
   * Maps a raw OTT time entry to the delete-request payload expected by OTT.
   */
  private buildDeleteEntry(te: OttTimeEntry): OttDeleteTimeEntry {
    const dateLogged = Number(te.dateLogged)
    const hoursLogged = Number(te.hoursLogged)
    const loggedFor = Number(te.loggedFor) || Number(this.userId)
    return {
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
    }
  }

  /**
   * Sends an HTTP request to the given OTT API with the body serialized as JSON.
   * Tolerates empty or non-JSON responses by normalizing them to a status payload.
   * @param method The HTTP method (e.g. 'POST', 'DELETE').
   * @param path The OTT API endpoint to call.
   * @param body The request payload, serialized to JSON.
   * @returns The parsed (or normalized) JSON response.
   */
  private async apiRequest(
    method: string,
    path: string,
    body: unknown,
  ): Promise<{ status?: string; message?: string }> {
    if (!this.authorizationHeader) {
      throw new Error('No authorization header captured')
    }
    return this.page.evaluate(
      async ({ method, path, auth, body }) => {
        const response = await fetch(path, {
          method,
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
      { method, path, auth: this.authorizationHeader, body },
    )
  }
}
