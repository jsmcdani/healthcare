/**
 * Knowledge Pack Tools for Healthcare Builder Agent
 *
 * Tools for creating and managing knowledge packs containing clinical guidelines,
 * drug formularies, lab reference ranges, and other domain knowledge.
 */

export const knowledgePackTools = [
  {
    name: 'create_knowledge_pack',
    description: 'Create a new knowledge pack with clinical content.',
    input_schema: {
      type: 'object',
      properties: {
        packId: {
          type: 'string',
          description: 'Unique identifier for the pack (e.g., cardiology_guidelines_2024)'
        },
        name: {
          type: 'string',
          description: 'Human-readable name'
        },
        category: {
          type: 'string',
          enum: ['guidelines', 'formulary', 'reference_ranges', 'protocols', 'policies', 'general'],
          description: 'Category of knowledge'
        },
        specialty: {
          type: 'string',
          description: 'Medical specialty (e.g., cardiology, oncology)'
        },
        source: {
          type: 'string',
          description: 'Authoritative source (e.g., AHA, NICE, FDA)'
        },
        version: {
          type: 'string',
          description: 'Version identifier',
          default: '1.0.0'
        },
        entries: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string', description: 'Entry key/identifier' },
              title: { type: 'string', description: 'Entry title' },
              content: { type: 'string', description: 'Entry content' },
              tags: { type: 'array', items: { type: 'string' } },
              metadata: { type: 'object' }
            },
            required: ['key', 'content']
          },
          description: 'Knowledge entries'
        },
        validFrom: {
          type: 'string',
          description: 'ISO date from which this knowledge is valid'
        },
        validTo: {
          type: 'string',
          description: 'ISO date until which this knowledge is valid'
        }
      },
      required: ['packId', 'name', 'category']
    },
    handler: async (orchestrator, input) => {
      try {
        const db = orchestrator.arango?.db;

        const pack = {
          _key: input.packId,
          packId: input.packId,
          name: input.name,
          category: input.category,
          specialty: input.specialty,
          source: input.source,
          version: input.version || '1.0.0',
          entries: input.entries || [],
          entryCount: (input.entries || []).length,
          validFrom: input.validFrom,
          validTo: input.validTo,
          status: 'active',
          createdAt: new Date().toISOString(),
          createdBy: input._actor || 'system',
          orgId: input._orgId || input.orgId
        };

        if (db) {
          const col = db.collection('knowledge_packs');
          const exists = await col.exists();
          if (!exists) {
            await db.createCollection('knowledge_packs');
          }
          await col.save(pack);
        }

        // Register with knowledge engine if available
        if (orchestrator.knowledgeEngine) {
          await orchestrator.knowledgeEngine.loadKnowledgeBase(input.packId, input.entries || []);
        }

        return {
          success: true,
          packId: input.packId,
          name: input.name,
          category: input.category,
          entryCount: (input.entries || []).length,
          message: `Knowledge pack '${input.name}' created successfully`
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  },

  {
    name: 'import_clinical_guidelines',
    description: 'Import clinical guidelines from standard sources (NICE, AHA, ACC, etc.).',
    input_schema: {
      type: 'object',
      properties: {
        packId: {
          type: 'string',
          description: 'Target pack ID to import into'
        },
        source: {
          type: 'string',
          enum: ['NICE', 'AHA', 'ACC', 'ASCO', 'CDC', 'WHO', 'custom'],
          description: 'Source organization'
        },
        guidelineId: {
          type: 'string',
          description: 'Specific guideline identifier'
        },
        guidelineData: {
          type: 'object',
          description: 'Guideline content for custom imports',
          properties: {
            title: { type: 'string' },
            summary: { type: 'string' },
            recommendations: { type: 'array', items: { type: 'string' } },
            evidence_level: { type: 'string' },
            last_updated: { type: 'string' }
          }
        },
        replaceExisting: {
          type: 'boolean',
          description: 'Replace existing entries with same key',
          default: false
        }
      },
      required: ['packId', 'source']
    },
    handler: async (orchestrator, input) => {
      try {
        const db = orchestrator.arango?.db;

        // For custom imports, use provided data
        let guidelineEntries = [];
        if (input.source === 'custom' && input.guidelineData) {
          guidelineEntries = [{
            key: input.guidelineId || `custom_${Date.now()}`,
            title: input.guidelineData.title,
            content: input.guidelineData.summary,
            recommendations: input.guidelineData.recommendations,
            evidenceLevel: input.guidelineData.evidence_level,
            lastUpdated: input.guidelineData.last_updated,
            source: 'custom',
            type: 'guideline'
          }];
        } else {
          // Mock guideline data for standard sources
          guidelineEntries = getMockGuidelines(input.source, input.guidelineId);
        }

        if (db) {
          const col = db.collection('knowledge_packs');
          const cursor = await db.query(`
            FOR p IN knowledge_packs
            FILTER p.packId == @packId
            RETURN p
          `, { packId: input.packId });
          const packs = await cursor.all();

          if (packs.length === 0) {
            return { success: false, error: `Pack '${input.packId}' not found` };
          }

          const pack = packs[0];
          const existingKeys = new Set((pack.entries || []).map(e => e.key));

          let addedCount = 0;
          let updatedCount = 0;
          const newEntries = [...(pack.entries || [])];

          for (const entry of guidelineEntries) {
            if (existingKeys.has(entry.key)) {
              if (input.replaceExisting) {
                const index = newEntries.findIndex(e => e.key === entry.key);
                newEntries[index] = entry;
                updatedCount++;
              }
            } else {
              newEntries.push(entry);
              addedCount++;
            }
          }

          await col.update(pack._key, {
            entries: newEntries,
            entryCount: newEntries.length,
            updatedAt: new Date().toISOString(),
            updatedBy: input._actor || 'system'
          });

          return {
            success: true,
            packId: input.packId,
            source: input.source,
            guidelinesProcessed: guidelineEntries.length,
            added: addedCount,
            updated: updatedCount,
            totalEntries: newEntries.length,
            message: `Imported ${addedCount} guidelines from ${input.source}`
          };
        }

        return { success: false, error: 'Database not available' };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  },

  {
    name: 'import_formulary',
    description: 'Import drug formulary data.',
    input_schema: {
      type: 'object',
      properties: {
        packId: {
          type: 'string',
          description: 'Target pack ID'
        },
        formularyData: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              drugName: { type: 'string' },
              genericName: { type: 'string' },
              drugClass: { type: 'string' },
              tier: { type: 'number' },
              requiresPriorAuth: { type: 'boolean' },
              restrictions: { type: 'array', items: { type: 'string' } },
              alternatives: { type: 'array', items: { type: 'string' } },
              interactions: { type: 'array', items: { type: 'string' } }
            },
            required: ['drugName']
          },
          description: 'Drug formulary entries'
        },
        source: {
          type: 'string',
          description: 'Formulary source (e.g., PBM name, health plan)'
        }
      },
      required: ['packId', 'formularyData']
    },
    handler: async (orchestrator, input) => {
      try {
        const db = orchestrator.arango?.db;

        const formularyEntries = input.formularyData.map(drug => ({
          key: `drug_${drug.drugName.toLowerCase().replace(/\s+/g, '_')}`,
          title: drug.drugName,
          content: JSON.stringify({
            genericName: drug.genericName,
            drugClass: drug.drugClass,
            tier: drug.tier,
            requiresPriorAuth: drug.requiresPriorAuth,
            restrictions: drug.restrictions,
            alternatives: drug.alternatives,
            interactions: drug.interactions
          }),
          type: 'formulary',
          source: input.source,
          tags: [drug.drugClass, `tier_${drug.tier}`].filter(Boolean)
        }));

        if (db) {
          const col = db.collection('knowledge_packs');
          const cursor = await db.query(`
            FOR p IN knowledge_packs
            FILTER p.packId == @packId
            RETURN p
          `, { packId: input.packId });
          const packs = await cursor.all();

          if (packs.length === 0) {
            return { success: false, error: `Pack '${input.packId}' not found` };
          }

          const pack = packs[0];
          const newEntries = [...(pack.entries || []), ...formularyEntries];

          await col.update(pack._key, {
            entries: newEntries,
            entryCount: newEntries.length,
            updatedAt: new Date().toISOString()
          });

          return {
            success: true,
            packId: input.packId,
            drugsImported: formularyEntries.length,
            totalEntries: newEntries.length,
            drugClasses: [...new Set(input.formularyData.map(d => d.drugClass).filter(Boolean))],
            message: `Imported ${formularyEntries.length} drugs to formulary`
          };
        }

        return { success: false, error: 'Database not available' };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  },

  {
    name: 'import_reference_ranges',
    description: 'Import lab reference ranges.',
    input_schema: {
      type: 'object',
      properties: {
        packId: {
          type: 'string',
          description: 'Target pack ID'
        },
        referenceRanges: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              testName: { type: 'string' },
              testCode: { type: 'string' },
              unit: { type: 'string' },
              normalRange: {
                type: 'object',
                properties: {
                  min: { type: 'number' },
                  max: { type: 'number' }
                }
              },
              criticalLow: { type: 'number' },
              criticalHigh: { type: 'number' },
              ageRanges: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    minAge: { type: 'number' },
                    maxAge: { type: 'number' },
                    normalRange: { type: 'object' }
                  }
                }
              },
              genderSpecific: {
                type: 'object',
                properties: {
                  male: { type: 'object' },
                  female: { type: 'object' }
                }
              }
            },
            required: ['testName', 'unit']
          },
          description: 'Lab reference range entries'
        },
        source: {
          type: 'string',
          description: 'Reference source (e.g., lab vendor, hospital)'
        }
      },
      required: ['packId', 'referenceRanges']
    },
    handler: async (orchestrator, input) => {
      try {
        const db = orchestrator.arango?.db;

        const rangeEntries = input.referenceRanges.map(range => ({
          key: `lab_${(range.testCode || range.testName).toLowerCase().replace(/\s+/g, '_')}`,
          title: range.testName,
          content: JSON.stringify({
            testCode: range.testCode,
            unit: range.unit,
            normalRange: range.normalRange,
            criticalLow: range.criticalLow,
            criticalHigh: range.criticalHigh,
            ageRanges: range.ageRanges,
            genderSpecific: range.genderSpecific
          }),
          type: 'reference_range',
          source: input.source,
          tags: ['lab', 'reference_range', range.testCode].filter(Boolean)
        }));

        if (db) {
          const col = db.collection('knowledge_packs');
          const cursor = await db.query(`
            FOR p IN knowledge_packs
            FILTER p.packId == @packId
            RETURN p
          `, { packId: input.packId });
          const packs = await cursor.all();

          if (packs.length === 0) {
            return { success: false, error: `Pack '${input.packId}' not found` };
          }

          const pack = packs[0];
          const newEntries = [...(pack.entries || []), ...rangeEntries];

          await col.update(pack._key, {
            entries: newEntries,
            entryCount: newEntries.length,
            updatedAt: new Date().toISOString()
          });

          return {
            success: true,
            packId: input.packId,
            rangesImported: rangeEntries.length,
            totalEntries: newEntries.length,
            tests: input.referenceRanges.map(r => r.testName),
            message: `Imported ${rangeEntries.length} reference ranges`
          };
        }

        return { success: false, error: 'Database not available' };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  },

  {
    name: 'update_knowledge_pack',
    description: 'Update a knowledge pack\'s content or metadata.',
    input_schema: {
      type: 'object',
      properties: {
        packId: {
          type: 'string',
          description: 'Pack ID to update'
        },
        updates: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            version: { type: 'string' },
            validTo: { type: 'string' },
            status: { type: 'string', enum: ['active', 'deprecated', 'archived'] }
          },
          description: 'Fields to update'
        },
        addEntries: {
          type: 'array',
          items: { type: 'object' },
          description: 'New entries to add'
        },
        removeEntryKeys: {
          type: 'array',
          items: { type: 'string' },
          description: 'Entry keys to remove'
        }
      },
      required: ['packId']
    },
    handler: async (orchestrator, input) => {
      try {
        const db = orchestrator.arango?.db;

        if (db) {
          const col = db.collection('knowledge_packs');
          const cursor = await db.query(`
            FOR p IN knowledge_packs
            FILTER p.packId == @packId
            RETURN p
          `, { packId: input.packId });
          const packs = await cursor.all();

          if (packs.length === 0) {
            return { success: false, error: `Pack '${input.packId}' not found` };
          }

          const pack = packs[0];
          let entries = [...(pack.entries || [])];

          // Remove entries
          if (input.removeEntryKeys?.length) {
            const removeSet = new Set(input.removeEntryKeys);
            entries = entries.filter(e => !removeSet.has(e.key));
          }

          // Add entries
          if (input.addEntries?.length) {
            entries = [...entries, ...input.addEntries];
          }

          const updateData = {
            ...(input.updates || {}),
            entries,
            entryCount: entries.length,
            updatedAt: new Date().toISOString(),
            updatedBy: input._actor || 'system'
          };

          await col.update(pack._key, updateData);

          return {
            success: true,
            packId: input.packId,
            entriesAdded: (input.addEntries || []).length,
            entriesRemoved: (input.removeEntryKeys || []).length,
            totalEntries: entries.length,
            updatedFields: Object.keys(input.updates || {}),
            message: `Knowledge pack '${input.packId}' updated`
          };
        }

        return { success: false, error: 'Database not available' };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  },

  {
    name: 'list_knowledge_packs',
    description: 'List all knowledge packs.',
    input_schema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          description: 'Filter by category'
        },
        specialty: {
          type: 'string',
          description: 'Filter by specialty'
        },
        status: {
          type: 'string',
          enum: ['active', 'deprecated', 'archived', 'all'],
          default: 'active'
        },
        includeEntries: {
          type: 'boolean',
          description: 'Include full entries in response',
          default: false
        }
      }
    },
    handler: async (orchestrator, input) => {
      try {
        const db = orchestrator.arango?.db;

        if (db) {
          let query = 'FOR p IN knowledge_packs';
          const filters = [];
          const bindVars = {};

          if (input.status !== 'all') {
            filters.push('p.status == @status');
            bindVars.status = input.status || 'active';
          }

          if (input.category) {
            filters.push('p.category == @category');
            bindVars.category = input.category;
          }

          if (input.specialty) {
            filters.push('p.specialty == @specialty');
            bindVars.specialty = input.specialty;
          }

          if (filters.length > 0) {
            query += ' FILTER ' + filters.join(' AND ');
          }

          query += ' RETURN p';

          const cursor = await db.query(query, bindVars);
          const packs = await cursor.all();

          return {
            success: true,
            count: packs.length,
            packs: packs.map(p => ({
              packId: p.packId,
              name: p.name,
              category: p.category,
              specialty: p.specialty,
              source: p.source,
              version: p.version,
              status: p.status,
              entryCount: p.entryCount,
              createdAt: p.createdAt,
              validFrom: p.validFrom,
              validTo: p.validTo,
              ...(input.includeEntries ? { entries: p.entries } : {})
            }))
          };
        }

        return {
          success: true,
          count: 0,
          packs: [],
          note: 'Database not available'
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  },

  {
    name: 'query_knowledge',
    description: 'Query knowledge packs for relevant information.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query'
        },
        packIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Specific packs to search (empty = all)'
        },
        category: {
          type: 'string',
          description: 'Filter by category'
        },
        limit: {
          type: 'number',
          description: 'Maximum results',
          default: 10
        }
      },
      required: ['query']
    },
    handler: async (orchestrator, input) => {
      try {
        const db = orchestrator.arango?.db;
        const results = [];

        if (db) {
          let query = `
            FOR p IN knowledge_packs
            FILTER p.status == 'active'
          `;
          const bindVars = {};

          if (input.packIds?.length) {
            query += ' FILTER p.packId IN @packIds';
            bindVars.packIds = input.packIds;
          }

          if (input.category) {
            query += ' FILTER p.category == @category';
            bindVars.category = input.category;
          }

          query += ' RETURN p';

          const cursor = await db.query(query, bindVars);
          const packs = await cursor.all();

          const queryLower = input.query.toLowerCase();

          for (const pack of packs) {
            for (const entry of pack.entries || []) {
              const titleMatch = entry.title?.toLowerCase().includes(queryLower);
              const contentMatch = entry.content?.toLowerCase().includes(queryLower);
              const tagMatch = entry.tags?.some(t => t.toLowerCase().includes(queryLower));

              if (titleMatch || contentMatch || tagMatch) {
                results.push({
                  packId: pack.packId,
                  packName: pack.name,
                  entryKey: entry.key,
                  title: entry.title,
                  content: entry.content?.substring(0, 500) + (entry.content?.length > 500 ? '...' : ''),
                  type: entry.type,
                  source: entry.source || pack.source,
                  relevance: titleMatch ? 1.0 : (tagMatch ? 0.8 : 0.6)
                });
              }
            }
          }

          // Sort by relevance and limit
          results.sort((a, b) => b.relevance - a.relevance);
          const limitedResults = results.slice(0, input.limit || 10);

          return {
            success: true,
            query: input.query,
            totalMatches: results.length,
            returnedCount: limitedResults.length,
            results: limitedResults
          };
        }

        // Use knowledge engine if no database
        if (orchestrator.knowledgeEngine) {
          const knowledge = await orchestrator.knowledgeEngine.getRelevantKnowledge(
            input.query,
            { category: input.category }
          );

          return {
            success: true,
            query: input.query,
            totalMatches: knowledge.length,
            results: knowledge.slice(0, input.limit || 10)
          };
        }

        return { success: false, error: 'No knowledge source available' };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  }
];

/**
 * Get mock guidelines for standard sources
 */
function getMockGuidelines(source, guidelineId) {
  const mockGuidelines = {
    AHA: [
      {
        key: 'aha_hf_2022',
        title: 'AHA Heart Failure Guidelines 2022',
        content: 'Comprehensive guidelines for diagnosis and management of heart failure including HFrEF, HFpEF, and HFmrEF classifications.',
        recommendations: [
          'Use GDMT (guideline-directed medical therapy) for HFrEF',
          'Recommend SGLT2 inhibitors for HFrEF',
          'Consider cardiac rehabilitation for all HF patients'
        ],
        evidenceLevel: 'A',
        source: 'AHA/ACC/HFSA',
        type: 'guideline',
        lastUpdated: '2022-04-01'
      }
    ],
    NICE: [
      {
        key: 'nice_dm_2022',
        title: 'NICE Diabetes Management Guidelines',
        content: 'Evidence-based recommendations for type 2 diabetes management in adults.',
        recommendations: [
          'First-line therapy with metformin',
          'HbA1c target of 48 mmol/mol (6.5%)',
          'Consider SGLT2 inhibitors for cardiovascular benefit'
        ],
        evidenceLevel: 'A',
        source: 'NICE',
        type: 'guideline',
        lastUpdated: '2022-08-15'
      }
    ],
    CDC: [
      {
        key: 'cdc_immunization_2024',
        title: 'CDC Immunization Schedule 2024',
        content: 'Recommended immunization schedule for children and adults.',
        recommendations: [
          'Annual influenza vaccination for all ages 6 months and older',
          'COVID-19 vaccination per current recommendations',
          'Pneumococcal vaccination for adults 65+'
        ],
        evidenceLevel: 'A',
        source: 'CDC/ACIP',
        type: 'guideline',
        lastUpdated: '2024-01-01'
      }
    ]
  };

  return mockGuidelines[source] || [];
}
