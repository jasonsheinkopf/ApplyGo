workspace "ApplyGo" "C4 architecture model of ApplyGo. Shows system shape only -- see docs/workflow/agent-workflow.md for behavior/sequencing." {

    model {
        candidate = person "Candidate" "The job seeker using ApplyGo."

        llmProviders = softwareSystem "LLM Providers" "Anthropic and OpenAI, used interchangeably for model calls." "External"
        atsSystems = softwareSystem "ATS & Application Sites" "Job board APIs and employer application pages ApplyGo integrates with." "External"

        applygo = softwareSystem "ApplyGo" "A personal, self-hosted job-search copilot that finds, scores, and helps apply to jobs." {

            worker = container "Worker / API" "Cloudflare Worker serving the JSON API and the candidate dashboard UI." "TypeScript, Cloudflare Workers" {
                apiDashboard = component "API & Dashboard" "Routes requests, handles session auth, and serves the dashboard UI." "TypeScript"
                profileEvidence = component "Profile & Evidence" "Manages the candidate's profile, documents, and evidence." "TypeScript"
                companyDiscovery = component "Company Discovery & Scanning" "Finds companies and scans their job boards for postings." "TypeScript"
                jobScreeningFit = component "Job Screening & Fit Assessment" "Screens and scores postings against the candidate's profile." "TypeScript"
                resumeGeneration = component "Resume Generation" "Generates and iteratively refines a tailored resume per job." "TypeScript"
                coverLetterGeneration = component "Cover Letter Generation" "Generates a tailored cover letter per job." "TypeScript"
                applicationMatching = component "Application Field Matching" "Answers live application-form fields for the browser extension." "TypeScript"
                devToolsTracing = component "Developer Console & Eval Harness" "Developer-only tracing, cost, and prompt-evaluation tooling." "TypeScript"

                apiDashboard -> profileEvidence "Routes to"
                apiDashboard -> companyDiscovery "Routes to"
                apiDashboard -> jobScreeningFit "Routes to"
                apiDashboard -> resumeGeneration "Routes to"
                apiDashboard -> coverLetterGeneration "Routes to"
                apiDashboard -> applicationMatching "Routes to"
                apiDashboard -> devToolsTracing "Routes to"
                jobScreeningFit -> profileEvidence "Reads"
                profileEvidence -> llmProviders "Calls"
                companyDiscovery -> llmProviders "Calls"
                companyDiscovery -> atsSystems "Polls"
                jobScreeningFit -> llmProviders "Calls"
                resumeGeneration -> llmProviders "Calls"
                coverLetterGeneration -> llmProviders "Calls"
                applicationMatching -> llmProviders "Calls"
                devToolsTracing -> llmProviders "Traces"
            }

            d1 = container "D1" "Structured application data." "Cloudflare D1 (SQLite)" "Database"
            r2 = container "R2" "Uploaded documents and rendered resume PDFs." "Cloudflare R2" "Database"
            extension = container "Browser Extension" "Fills job-application forms in the candidate's own browser session." "JavaScript, Chrome Extension MV3" "Browser Extension"
        }

        # System Context relationships
        candidate -> applygo "Uses"

        # Container-level relationships
        candidate -> worker "Uses"
        candidate -> extension "Uses for application assistance"
        worker -> d1 "Reads/writes"
        worker -> r2 "Stores files in"
        extension -> worker "Calls"
        extension -> atsSystems "Submits through"
        apiDashboard -> d1 "Reads/writes"
        apiDashboard -> r2 "Stores files in"
    }

    views {
        systemContext applygo "SystemContext" "ApplyGo and its users/external systems." {
            include *
            autoLayout lr
        }

        container applygo "Containers" "The main runtime pieces of ApplyGo." {
            include *
            autoLayout lr
        }

        component worker "WorkerComponents" "Major responsibilities inside the Worker." {
            include *
            autoLayout lr
        }

        styles {
            element "Person" {
                shape person
                background #08427b
                color #ffffff
            }
            element "Software System" {
                background #1168bd
                color #ffffff
            }
            element "External" {
                background #999999
                color #ffffff
            }
            element "Container" {
                background #438dd5
                color #ffffff
            }
            element "Component" {
                background #85bbf0
                color #000000
            }
            element "Database" {
                shape cylinder
            }
            element "Browser Extension" {
                shape webBrowser
            }
        }
    }
}
