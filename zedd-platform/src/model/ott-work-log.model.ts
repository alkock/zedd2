// Is the raw, unmapped return type from OTT. 
 
 interface OttWorkLogResponse {
    data: OttWorkLogData[]
  }

  interface OttWorkLogData {
    assignedIssues: OttAssignedIssue[]        //  Tasks
    assoBoardProjectCodes: OttProjectCode[]    // Join-Tabelle
    timeEntries: OttTimeEntry[]               //  später für Export
  }

  interface OttAssignedIssue {
    title: string
    appointmentId: number
    projectCode: number      // Join-Key zu projectCodeId
    engagementId: number     // Relevant für Export
    stickyNoteId: number     // Relevant für Export
  }

  interface OttProjectCode {
    projectCodeId: number
    gfsProjectCode: number   //  projectIntId
    gtmProjectName: string   //  projectName
    gfsTaskCode: string      //  taskCode
    boardId?: number         // Relevant für Export
  }

  interface OttTimeEntry {
    id: number                 // vorhanden bei bestehenden Einträgen (Update-Zweig)
    appointmentId: number
    dateLogged: number         // 20260316
    hoursLogged: number
    stickyNoteId: number
    engagementId: number
    boardId: number
    loggedFor: number
    trackingType: number
    issueName: string
    description: string
    workLocationId?: number
    workPlaceId?: number
  }

