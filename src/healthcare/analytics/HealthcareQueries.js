/**
 * Healthcare Analytics Queries
 * Common Gremlin queries for healthcare data analysis
 */

export class HealthcareQueries {
  constructor(graphService) {
    this.graph = graphService;
  }

  // ============================================
  // PATIENT QUERIES
  // ============================================

  /**
   * Get patient summary with all related data
   */
  async getPatientSummary(patientId) {
    const patient = await this.graph.client.query(
      `g.V('${patientId}').valueMap(true)`
    );

    const encounters = await this.graph.client.query(
      `g.V('${patientId}').out('HAS_ENCOUNTER').order().by('admitDate', desc).limit(10).valueMap(true)`
    );

    const diagnoses = await this.graph.client.query(
      `g.V('${patientId}').out('HAS_DIAGNOSIS').has('status', 'active').valueMap(true)`
    );

    const medications = await this.graph.client.query(
      `g.V('${patientId}').out('PRESCRIBED').has('status', 'active').valueMap(true)`
    );

    const allergies = await this.graph.client.query(
      `g.V('${patientId}').out('HAS_ALLERGY').valueMap(true)`
    );

    return {
      patient: patient[0],
      recentEncounters: encounters,
      activeConditions: diagnoses,
      activeMedications: medications,
      allergies
    };
  }

  /**
   * Find patients by diagnosis (ICD code)
   */
  async findPatientsByDiagnosis(icdCode, status = 'active') {
    return this.graph.client.query(
      `g.V().hasLabel('Diagnosis')
        .has('icdCode', '${icdCode}')
        .has('status', '${status}')
        .in('HAS_DIAGNOSIS')
        .dedup()
        .valueMap(true)`
    );
  }

  /**
   * Find patients on a specific medication
   */
  async findPatientsByMedication(medicationName) {
    return this.graph.client.query(
      `g.V().hasLabel('Medication')
        .has('genericName', textContains('${medicationName}'))
        .has('status', 'active')
        .in('PRESCRIBED')
        .hasLabel('Patient')
        .dedup()
        .valueMap(true)`
    );
  }

  /**
   * Get patients with multiple chronic conditions
   */
  async getMultiMorbidPatients(minConditions = 3) {
    return this.graph.client.query(
      `g.V().hasLabel('Patient')
        .where(out('HAS_DIAGNOSIS').has('status', 'active').count().is(gte(${minConditions})))
        .project('patient', 'conditionCount', 'conditions')
        .by(valueMap(true))
        .by(out('HAS_DIAGNOSIS').has('status', 'active').count())
        .by(out('HAS_DIAGNOSIS').has('status', 'active').values('description').fold())`
    );
  }

  // ============================================
  // POPULATION HEALTH QUERIES
  // ============================================

  /**
   * Get disease prevalence statistics
   */
  async getDiseasePrevalence() {
    return this.graph.client.query(
      `g.V().hasLabel('Diagnosis')
        .has('status', 'active')
        .groupCount()
        .by('icdCode')
        .order(local)
        .by(values, desc)`
    );
  }

  /**
   * Get medication utilization statistics
   */
  async getMedicationUtilization() {
    return this.graph.client.query(
      `g.V().hasLabel('Medication')
        .has('status', 'active')
        .groupCount()
        .by('genericName')
        .order(local)
        .by(values, desc)`
    );
  }

  /**
   * Find patients with care gaps (no visit in X months)
   */
  async findCareGaps(monthsThreshold = 12) {
    const cutoffDate = new Date();
    cutoffDate.setMonth(cutoffDate.getMonth() - monthsThreshold);
    const cutoff = cutoffDate.toISOString().split('T')[0];

    return this.graph.client.query(
      `g.V().hasLabel('Patient')
        .where(out('HAS_ENCOUNTER').has('admitDate', gte('${cutoff}')).count().is(0))
        .where(out('HAS_DIAGNOSIS').has('status', 'active').count().is(gt(0)))
        .project('patient', 'lastVisit', 'activeConditions')
        .by(valueMap('patientId', 'firstName', 'lastName'))
        .by(out('HAS_ENCOUNTER').values('admitDate').max())
        .by(out('HAS_DIAGNOSIS').has('status', 'active').count())`
    );
  }

  /**
   * Diabetic patients without recent A1c
   */
  async findDiabeticsMissingA1c(monthsThreshold = 6) {
    const cutoffDate = new Date();
    cutoffDate.setMonth(cutoffDate.getMonth() - monthsThreshold);
    const cutoff = cutoffDate.toISOString().split('T')[0];

    return this.graph.client.query(
      `g.V().hasLabel('Patient')
        .where(out('HAS_DIAGNOSIS').has('icdCode', 'E11.9').has('status', 'active'))
        .where(out('HAS_LAB_RESULT').has('loincCode', '4548-4').has('collectionDate', gte('${cutoff}')).count().is(0))
        .project('patient', 'lastA1c', 'lastA1cDate')
        .by(valueMap('patientId', 'firstName', 'lastName'))
        .by(out('HAS_LAB_RESULT').has('loincCode', '4548-4').values('value').max())
        .by(out('HAS_LAB_RESULT').has('loincCode', '4548-4').values('collectionDate').max())`
    );
  }

  // ============================================
  // CLINICAL DECISION SUPPORT
  // ============================================

  /**
   * Check for drug-allergy interactions
   */
  async checkDrugAllergyInteractions(patientId, proposedMedication) {
    const allergies = await this.graph.client.query(
      `g.V('${patientId}').out('HAS_ALLERGY').values('allergen').fold()`
    );

    // Simple check - in production would use drug interaction database
    const dangerousAllergies = {
      'Penicillin': ['Amoxicillin', 'Ampicillin', 'Penicillin'],
      'Sulfa drugs': ['Sulfamethoxazole', 'Bactrim'],
      'NSAIDs': ['Ibuprofen', 'Naproxen', 'Aspirin'],
      'Aspirin': ['Aspirin']
    };

    const interactions = [];
    for (const allergy of allergies[0] || []) {
      const contraindicated = dangerousAllergies[allergy] || [];
      if (contraindicated.some(drug => proposedMedication.toLowerCase().includes(drug.toLowerCase()))) {
        interactions.push({
          allergy,
          medication: proposedMedication,
          severity: 'high',
          recommendation: `Patient allergic to ${allergy}. Avoid ${proposedMedication}.`
        });
      }
    }

    return {
      safe: interactions.length === 0,
      interactions
    };
  }

  /**
   * Get patients with critical lab values
   */
  async getCriticalLabResults() {
    return this.graph.client.query(
      `g.V().hasLabel('LabResult')
        .has('status', 'critical')
        .order().by('resultDate', desc)
        .limit(50)
        .project('lab', 'patient', 'encounter')
        .by(valueMap(true))
        .by(in('HAS_LAB_RESULT').valueMap('patientId', 'firstName', 'lastName'))
        .by(in('ORDERED').hasLabel('Encounter').valueMap('encounterId', 'admitDate'))`
    );
  }

  /**
   * Find patients with uncontrolled diabetes (A1c > 9)
   */
  async findUncontrolledDiabetics() {
    return this.graph.client.query(
      `g.V().hasLabel('LabResult')
        .has('loincCode', '4548-4')
        .has('value', gt(9.0))
        .order().by('resultDate', desc)
        .dedup().by(in('HAS_LAB_RESULT'))
        .project('patient', 'a1cValue', 'testDate')
        .by(in('HAS_LAB_RESULT').valueMap('patientId', 'firstName', 'lastName'))
        .by(values('value'))
        .by(values('resultDate'))`
    );
  }

  // ============================================
  // PROVIDER ANALYTICS
  // ============================================

  /**
   * Get provider panel size and patient distribution
   */
  async getProviderPanelStats() {
    return this.graph.client.query(
      `g.V().hasLabel('Provider')
        .project('provider', 'patientCount', 'encounterCount')
        .by(valueMap('providerId', 'firstName', 'lastName', 'specialty'))
        .by(in('ATTENDED_BY').in('HAS_ENCOUNTER').dedup().count())
        .by(in('ATTENDED_BY').count())`
    );
  }

  /**
   * Get encounter volume by provider
   */
  async getProviderEncounterVolume(startDate, endDate) {
    return this.graph.client.query(
      `g.V().hasLabel('Encounter')
        .has('admitDate', gte('${startDate}'))
        .has('admitDate', lte('${endDate}'))
        .groupCount()
        .by(out('ATTENDED_BY').values('lastName'))`
    );
  }

  // ============================================
  // TEMPORAL ANALYTICS
  // ============================================

  /**
   * Get encounter trends by month
   */
  async getEncounterTrends(year) {
    return this.graph.client.query(
      `g.V().hasLabel('Encounter')
        .has('admitDate', gte('${year}-01-01'))
        .has('admitDate', lt('${year + 1}-01-01'))
        .group()
        .by(values('admitDate').substring(0, 7))
        .by(count())`
    );
  }

  /**
   * Get patient visit frequency distribution
   */
  async getVisitFrequencyDistribution(year) {
    return this.graph.client.query(
      `g.V().hasLabel('Patient')
        .project('patient', 'visitCount')
        .by(values('patientId'))
        .by(out('HAS_ENCOUNTER').has('admitDate', gte('${year}-01-01')).has('admitDate', lt('${year + 1}-01-01')).count())
        .group()
        .by(select('visitCount'))
        .by(count())`
    );
  }

  // ============================================
  // GRAPH STATISTICS
  // ============================================

  /**
   * Get comprehensive graph statistics
   */
  async getGraphStats() {
    const [vertexCounts] = await this.graph.client.query(
      `g.V().groupCount().by(label)`
    );

    const [edgeCounts] = await this.graph.client.query(
      `g.E().groupCount().by(label)`
    );

    const [dateRange] = await this.graph.client.query(
      `g.V().hasLabel('Encounter')
        .fold()
        .project('earliest', 'latest', 'total')
        .by(unfold().values('admitDate').min())
        .by(unfold().values('admitDate').max())
        .by(unfold().count())`
    );

    return {
      vertices: vertexCounts,
      edges: edgeCounts,
      dateRange
    };
  }
}

export default HealthcareQueries;
