# Servient Platform

Multi-Org Salesforce Intelligence Platform with AI-powered orchestration and metadata management.

## <¯ Current Status (August 18, 2025)

###  **Major Milestone: Config System Unification Complete**

**Problem Solved**: Resolved critical authentication issues caused by competing config systems from merged applications.

- **Before**: Two config systems (`config/index.js` vs `src/utils/config.js`) causing "mystery bugs"
- **After**: Unified on original `config/index.js` with `SF_*` environment variables
- **Result**: SalesforceService authentication working with 606 Account fields verified

### =€ **Platform Architecture Status**

#### **Core Services - All Operational**
```
 ServientOrchestrator     - Service mesh coordination (5 services, 17 MCP handlers)
 SalesforceService        - Salesforce API integration (authentication verified)
 MetadataIngestionService - Multi-org metadata collection (initialized)
 LabelMismatchService     - Label standardization analysis 
 ValidationService        - Data validation and MCP tools
 PromptService           - AI integration with orchestrator awareness
```

#### **Database Layer - Connected**
```
 ArangoDB - Graph database for metadata and relationships
 Redis    - High-performance caching and session management
```

#### **Authentication & Config**
```
 Unified config system using config/index.js
 SF_* environment variables (SF_USERNAME, SF_PASSWORD, etc.)
 SalesforceService credential flow working
 Multi-org support with tenant isolation
```

## =' **Quick Start**

### Prerequisites
- Node.js 18+
- ArangoDB running on localhost:8529
- Redis running on localhost:6379

### Installation
```bash
npm install
npm run setup        # Initialize ArangoDB schemas
```

### Environment Configuration
Copy `.env.example` to `.env` and configure:
```bash
# Salesforce Integration
SF_USERNAME=your-username
SF_PASSWORD=your-password+security-token
SF_CLIENT_ID=your-connected-app-client-id
SF_CLIENT_SECRET=your-connected-app-secret
SF_LOGIN_URL=https://test.salesforce.com

# Database
ARANGO_URL=http://localhost:8529
ARANGO_PASSWORD=your-password
REDIS_URL=redis://localhost:6379

# AI Services
ANTHROPIC_API_KEY=your-api-key
```

### Start Development Server
```bash
npm run dev          # Development server with hot reload
npm start           # Production server
```

### Test Platform
```bash
npm run test:health  # Health checks
npm run test:label   # Label mismatch API endpoints
```

## =Ë **Development Commands**

### Database Management
```bash
npm run setup               # Initialize ArangoDB schemas
npm run create-org          # Create test organization
npm run docker:up          # Start ArangoDB + Redis containers
```

### Testing
```bash
npm test                   # Unit tests
npm run test:api          # API endpoint tests
npm run test:health       # System health verification
```

## <× **Architecture Overview**

### **Service-Oriented Architecture with MCP Integration**
- **API Layer**: Express.js REST API with WebSocket support
- **Orchestration**: ServientOrchestrator manages service lifecycle and dependencies
- **Service Mesh**: Modular business logic with dependency injection
- **AI Integration**: Model Context Protocol (MCP) for LLM orchestration
- **Data Layer**: ArangoDB (graph) + Redis (cache) with multi-tenant isolation

### **Key Components**
- **ServientOrchestrator**: Central coordination hub for all services
- **SalesforceService**: Salesforce API integration with identity propagation
- **MetadataIngestionService**: Intelligent metadata collection and processing
- **MCP Server**: AI agent communication and tool orchestration

## <¯ **Next Development Priorities**

### **Immediate (Ready to Implement)**
1. **Add Metadata Operations to SalesforceService**
   - Implement `listMetadata()` and `retrieveMetadata()` methods
   - Support CustomObject, Flow, ApexClass metadata types
   - Enable full MetadataIngestionService functionality

2. **Complete Metadata Pipeline**
   - Test Salesforce ’ ArangoDB ingestion flow
   - Implement cache layer integration
   - Add batch processing and rate limiting

### **Near-term**
3. **Data Access Layer (DAL)** - Unified query interface across data sources
4. **LLM Orchestration Engine** - AI-driven workflow management
5. **Function Chaining System** - Multi-step operation automation

## =á **Resolved Issues**

### **Config System Unification (August 18, 2025)**
- **Issue**: Mixed config systems causing authentication failures
- **Root Cause**: Merged apps using different variable naming (`SF_*` vs `SALESFORCE_*`)
- **Solution**: Standardized on original `config/index.js` system
- **Files Changed**: 
  - `src/index.js` - Updated config import path
  - `src/api/middleware/*` - Unified config imports
  - `src/services/MetadataIngestionService.js` - Added shutdown method
  - Environment variables updated to `SF_*` pattern

### **SalesforceService Authentication**
- **Status**:  **Working** - Account describe returns 606 fields
- **Integration User**: Configured via SF_USERNAME/SF_PASSWORD
- **API Verification**: Contact describe returns 218 fields
- **No Warnings**: "Integration user credentials not configured" eliminated

## =Ê **Project Health Metrics**

### **Service Status**
- **Orchestrator**: 5 services initialized, 17 MCP handlers registered
- **Database**: ArangoDB + Redis connections verified
- **Authentication**: Salesforce API calls successful
- **Configuration**: Single source of truth established

### **Code Quality**
- **Config Consistency**: 100% unified on `config/index.js`
- **Service Dependencies**: All properly wired through orchestrator
- **Error Handling**: Graceful service initialization and shutdown
- **Test Coverage**: Core authentication and service integration verified

## = **Related Documentation**

- `CLAUDE.md` - Complete development guidance and architecture details
- `config/index.js` - Central configuration system
- `src/core/ServientOrchestrator.js` - Service mesh implementation
- `src/services/SalesforceService.js` - Salesforce integration patterns

---

*Last Updated: August 18, 2025 - Config System Unification Milestone*