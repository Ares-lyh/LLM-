export type Role = 'admin' | 'teacher';
export type StudentStatus = 'lead' | 'trial' | 'active' | 'lost';
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

export interface StudentDto {
  id: string;
  name: string;
  guardianName: string;
  guardianPhone: string;
  ownerId: string;
  ownerName: string;
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

export interface ApiError {
  error: string;
  code: string;
}

export interface CreateLeadInput {
  studentName: string;
  guardianName: string;
  guardianPhone: string;
  channel: string;
  summary: string;
}

export interface ScheduleTrialInput {
  scheduledAt: string;
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
