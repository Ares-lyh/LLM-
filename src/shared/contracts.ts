export type Role = 'admin' | 'teacher';
export type StudentStatus = 'lead' | 'trial' | 'enrollment_intent' | 'lost';
export type InquiryStatus = 'new' | 'contacted' | 'trial_scheduled' | 'converted' | 'lost';
export type TrialStatus = 'scheduled' | 'completed' | 'cancelled';
export type TrialOutcome = 'interested' | 'undecided' | 'not_interested';
export type FollowUpStatus = 'pending' | 'completed' | 'skipped';
export type FollowUpOutcome = 'continue' | 'converted' | 'lost';

export interface UserDto {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export interface TeacherDto { id: string; name: string }
export interface CreateTeacherInput { name: string; email: string; password: string }

export interface StudentDto {
  id: string;
  name: string;
  guardianName: string;
  guardianPhone: string;
  ownerId: string;
  ownerName: string;
  teacherId: string | null;
  teacherName: string | null;
  status: StudentStatus;
  createdAt: string;
}

export interface InquiryDto {
  id: string;
  studentId: string;
  studentName: string;
  channel: string;
  summary: string;
  status: InquiryStatus;
  createdAt: string;
}

export interface TrialDto {
  id: string;
  inquiryId: string;
  studentId: string;
  studentName: string;
  scheduledAt: string;
  status: TrialStatus;
  outcome: TrialOutcome | null;
  notes: string | null;
  teacherName: string | null;
}

export interface TeacherAssignmentDto {
  teacherId: string;
  teacherName: string;
  assignedAt: string;
  assignedByName: string;
}

export interface TrialRescheduleDto {
  trialId: string;
  previousScheduledAt: string;
  scheduledAt: string;
  reason: string;
  changedAt: string;
  changedByName: string;
}

export interface TrialCancellationDto {
  trialId: string;
  reason: string;
  cancelledAt: string;
  cancelledByName: string;
}

export interface FollowUpDto {
  id: string;
  inquiryId: string;
  studentId: string;
  studentName: string;
  dueAt: string;
  status: FollowUpStatus;
  note: string;
  aiSummary: string | null;
  resultNote?: string | null;
  resultOutcome?: FollowUpOutcome | null;
}

export interface StudentDetailDto {
  student: StudentDto;
  inquiries: InquiryDto[];
  trials: TrialDto[];
  followUps: FollowUpDto[];
  teacherHistory: TeacherAssignmentDto[];
  trialReschedules: TrialRescheduleDto[];
  trialCancellations: TrialCancellationDto[];
}

export interface DashboardDto {
  counts: {
    students: number;
    pendingFollowUps: number;
    todayTrials: number;
    overdueFollowUps: number;
  };
  inquiries: InquiryDto[];
  trials: TrialDto[];
  followUps: FollowUpDto[];
}

export interface StudentDirectoryDto {
  items: InquiryDto[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface ApiError {
  error: string;
  code: string;
  matches?: DuplicateStudentDto[];
}

export interface CreateLeadInput {
  studentName: string;
  guardianName: string;
  guardianPhone: string;
  channel: string;
  summary: string;
  allowDuplicate?: boolean;
}

export interface DuplicateStudentDto {
  id: string;
  name: string;
  guardianName: string;
  guardianPhone: string;
  status: StudentStatus;
  createdAt: string;
}

export interface StudentContactInput {
  name: string;
  guardianName: string;
  guardianPhone: string;
}

export interface UpdateStudentInput extends StudentContactInput {
  expected: StudentContactInput;
}

export interface CreateInquiryInput {
  channel: string;
  summary: string;
}

export interface ScheduleTrialInput {
  scheduledAt: string;
  teacherId?: string;
}

export interface AssignTeacherInput {
  teacherId: string;
  expectedTeacherId: string | null;
}

export interface RescheduleTrialInput {
  scheduledAt: string;
  expectedScheduledAt: string;
  reason: string;
}

export interface CancelTrialInput {
  expectedScheduledAt: string;
  reason: string;
}

export interface CompleteTrialInput {
  outcome: TrialOutcome;
  notes: string;
  followUpDueAt?: string;
}

export interface CompleteFollowUpInput {
  notes: string;
  outcome: FollowUpOutcome;
  nextDueAt?: string;
}
