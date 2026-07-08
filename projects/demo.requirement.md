---
id: PS-001
project: "AI Workforce Learning Hub"
author: "@product-owner"
created_at: 2026-05-12
status: ready-for-planning
---

# Problem Statement: AI Workforce Learning Hub

## Problem

Organizations need a structured web application to support employee reskilling and upskilling, starting with AI Engineering, AI-enabled DevOps Engineering, and Data Engineering competencies. Today, course content, skill expectations, learning progress, certifications, and manager visibility are fragmented across manual documents or disconnected tools. Employees do not have a single guided place to understand what to learn next, managers lack reliable visibility into team development, and competence leads cannot consistently identify skill gaps across teams or departments.

The application should provide clear learning paths with courses organized by Basic, Intermediate, and Advanced levels. Courses must include title, description, target skill area, level, syllabus, estimated duration, prerequisites, study materials, quizzes, and certification criteria.

Employees should be able to browse courses, enroll in courses or learning paths, follow step-by-step learning agendas, access materials and links, complete quizzes, track progress, and receive certifications. Managers should be able to assign courses to team members, monitor progress, and generate skill development reports. Visitors should only be able to browse the public course catalog and public course details. Admins should manage course content, categories, syllabi, materials, quizzes, certifications, user accounts, roles, permissions, and system settings. Competence leads should define learning paths, analyze skill development, generate reports, and identify skill gaps within teams or departments.

Although the first version focuses on AI Engineering, AI-enabled DevOps Engineering, and Data Engineering, the application must be designed to support additional skill areas in the future without rewriting core catalog, path, enrollment, reporting, or role-management flows.

## Target users (personas)

| Persona | Description | Primary goal |
|---|---|---|
| `visitor` | Unauthenticated user who can browse public catalog information. | Understand available learning opportunities before requesting access. |
| `employee` | Authenticated employee who wants to reskill or upskill. | Enroll, learn step by step, complete quizzes, track progress, and earn certifications. |
| `manager` | Authenticated people manager responsible for team development. | Assign courses or learning paths and monitor team progress and certifications. |
| `admin` | Platform administrator responsible for content, users, roles, permissions, and settings. | Keep catalog, user access, and certification rules accurate and controlled. |
| `competence-lead` | Capability owner responsible for skill frameworks and workforce insights. | Define learning paths, analyze skills, report progress, and identify gaps. |

## Core capabilities

1. **Course Catalog**: Users can browse available reskill/upskill courses and view course details such as title, description, target skill area, level, syllabus, duration, prerequisites, study materials, quizzes, and certification criteria.
2. **Learning Paths**: Competence leads can define structured learning paths for target roles such as AI Engineer, AI-enabled DevOps Engineer, and Data Engineer. Each learning path can include Basic, Intermediate, and Advanced levels.
3. **Course Enrollment**: Employees can enroll in available courses or learning paths based on their role, interest, or assigned development plan.
4. **Step-by-Step Learning Progress**: Employees can follow course agendas step by step, access study materials, open related links, complete quizzes, and track course completion status.
5. **Employee Dashboard**: Employees can view enrolled courses, progress status, completed courses, quiz results, and earned certifications.
6. **Course Assignment by Managers**: Managers can assign courses or learning paths to their team members based on development needs.
7. **Manager Dashboard**: Managers can monitor team members' learning progress, course completion status, certifications, and skill development reports.
8. **Visitor Course Browsing**: Visitors can browse the public course catalog and view general course information, but they cannot enroll, track progress, complete quizzes, or receive certifications.
9. **Admin Content Management**: Admins can manage course content, course categories, syllabus, study materials, quizzes, certifications, user accounts, roles, permissions, and system settings.
10. **Competence Lead Reporting**: Competence leads can generate reports on skill development, analyze learning progress, and identify skill gaps across teams or departments.
11. **Skill Gap Analysis**: The application can compare employee learning progress and completed certifications against expected skill requirements for target roles.
12. **Certification Management**: The application can issue and display certifications after employees complete required courses, quizzes, or learning path criteria.
13. **Role-Based Access Control**: The application supports different permissions for employees, managers, visitors, admins, and competence leads.
14. **Scalable Skill Area Design**: The first version focuses on AI Engineering, AI-enabled DevOps Engineering, and Data Engineering, but the system must support adding new skill areas later.

## Non-goals (explicit out of scope for v1)

- **No external learning platform integration in v1**: The application will not integrate with external learning platforms or content providers.
- **No HR system integration in v1**: User and role management will be handled inside the application.
- **No AI-based course recommendation in v1**: Personalized AI recommendations are out of scope.
- **No gamification in v1**: Badges, leaderboards, points, and reward systems are out of scope.
- **No social learning or collaboration in v1**: Discussion forums, comments, chat, and peer collaboration are not included.
- **No native mobile app in v1**: The first version focuses on a responsive web application only.
- **No offline learning in v1**: Users cannot download courses or complete learning activities offline.
- **No multilingual support in v1**: The first version supports English only.
- **No advanced engagement analytics in v1**: Predictive engagement scoring and course-effectiveness prediction are out of scope.
- **No instructor management in v1**: Instructor assignment, instructor evaluation, and live training scheduling are not included.
- **No automatic content creation in v1**: Course content is prepared by the organization and managed by admins or competence leads.
- **No enterprise compliance automation in v1**: External audit workflows and automatic compliance reporting are out of scope.

## Non-functional requirements

- **Accessibility**: WCAG 2.1 AA on all user-facing pages, including keyboard navigation, visible focus states, semantic landmarks, and accessible form errors.
- **Performance**: LCP < 2.5s on primary routes under normal load; no initial route should exceed a 200KB JavaScript budget without an explicit ADR.
- **Security**: Follow OWASP Top 10 practices, validate every mutation server-side, protect sessions, and rate-limit authentication routes.
- **Auth**: Email/password authentication for v1, with secure password hashing and server-managed sessions.
- **Authorization**: Role-based access control for visitor, employee, manager, admin, and competence lead capabilities.
- **i18n**: English only in v1; user-facing copy should remain centralized enough to support future localization.
- **Data protection**: Store only learning, role, and account data required for v1 workflows; avoid sensitive HR integrations; provide admin-controlled user deactivation.
- **Reliability**: Core learning and progress routes should fail with clear error states and must not lose submitted progress on validation errors.
- **Auditability**: Administrative content, assignment, role, and certification changes should record actor and timestamp where practical.

## Success metrics

- At least 80% of pilot employees can find and enroll in a relevant course or learning path without admin assistance.
- At least 70% of enrolled pilot employees complete one course or one learning-path level during the pilot period.
- Managers can view team progress and identify overdue or incomplete assignments in under two minutes.
- Competence leads can generate a skill-gap report for a team or department without manual spreadsheet consolidation.
- Admins can create or update a course, including syllabus, materials, quiz, and certification criteria, without engineering support.
- All release-candidate pages pass WCAG 2.1 AA automated checks and required keyboard interaction checks.

## Constraints

- **Stack**: Remix + TypeScript + PostgreSQL 15 + Tailwind CSS + Playwright + Vitest, per `CLAUDE.md`.
- **Data access**: SQL must live in `app/lib/db/`; routes must not contain inline SQL.
- **Validation**: Every mutating route action must validate with Zod and return `422` with `fieldErrors` on invalid input.
- **SEO**: Every route must export `meta()`.
- **Timeline**: Plan v1 as four implementation sprints: foundation, learner experience, manager/competence reporting, and admin/governance.
- **Team**: AI-assisted delivery with Claude Code for thinking phases and Codex for implementation, QA, and DevOps.

## Open questions

- What exact password policy and session expiry duration should be used for the pilot?
- Should managers be limited to direct reports only, or can they manage matrix/project teams?
- Which organizational hierarchy model is required for competence-lead reporting: team, department, location, or custom group?
- What quiz scoring threshold should trigger course completion or certification eligibility?
- Should certification expiry/renewal be included in v1 or deferred to a later release?
