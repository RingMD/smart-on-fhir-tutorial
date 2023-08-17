(function(window){
  window.extractData = function() {
    var ret = $.Deferred();

    function onError() {
      console.log('Loading error', arguments);
      ret.reject();
    }

    // http://docs.smarthealthit.org/client-js/fhirjs-equivalents
    function getQuery (params) {
      const query = new URLSearchParams()

      params.forEach(param => {
        query.append(param.key, param.value)
      })

      return query
    }

    async function readSlots (client) {
      const now = new Date()
      const later = new Date()
      later.setDate(now.getDate() + 30)
      const min = now.toISOString()
      const max = later.toISOString()
      // get from the sandbox test data - "Video Visit"
      // https://docs.google.com/document/d/10RnVyF1etl_17pyCyK96tyhUWRbrTyEcqpwzW-Z-Ybs/edit#heading=h.78lvm8ihmcyu
      // for production, service types must be provided by the implementation team
      const serviceType = 'https://fhir.cerner.com/ec2458f2-1e24-41c8-b71b-0e701af7583d/codeSet/14249|2572307911'
      const query = getQuery([
        { key: 'schedule.actor', value: client.user.fhirUser },
        { key: 'service-type', value: serviceType },
        { key: 'start', value: `ge${min}` },
        { key: 'start', value: `lt${max}` }
      ])
      const slots = await client.request(`Slot/?${query}`)

      console.log(slots)
    }

    function onReady(client)  {
      console.log('Practitioner resource identity: ' + client.user.fhirUser)
      console.log('Patient resource identity: ' + client.getState('serverUrl') + '/Patient/' + client.patient.id)

      readSlots(client)

      if (client.hasOwnProperty('patient')) {
        var pt = client.patient.read();
        const obvQuery = getQuery([
          { key: 'patient', value: client.patient.id },
          { key: 'code', value: [
                                  'http://loinc.org|8302-2',
                                  'http://loinc.org|8462-4',
                                  'http://loinc.org|8480-6',
                                  'http://loinc.org|2085-9',
                                  'http://loinc.org|2089-1',
                                  'http://loinc.org|55284-4'
                                ].join(',') }
        ])
        var obv = client.request(`Observation?${obvQuery}`, {
          pageLimit: 0,
          flat: true
        });

        $.when(pt, obv).fail(onError);

        $.when(pt, obv).done(function(patient, obv) {
          console.log(patient)
          var byCodes = client.byCodes(obv, 'code');
          var gender = patient.gender;

          var fname = '';
          var lname = '';

          if (typeof patient.name[0] !== 'undefined') {
            fname = patient.name[0].given.join(' ');
            // https://github.com/cerner/smart-on-fhir-tutorial/pull/213
            if (Array.isArray(patient.name[0].family)) {
              lname = patient.name[0].family.join(' ');
            } else {
              lname = patient.name[0].family;
            }
          }

          var height = byCodes('8302-2');
          var systolicbp = getBloodPressureValue(byCodes('55284-4'),'8480-6');
          var diastolicbp = getBloodPressureValue(byCodes('55284-4'),'8462-4');
          var hdl = byCodes('2085-9');
          var ldl = byCodes('2089-1');

          var p = defaultPatient();
          p.birthdate = patient.birthDate;
          p.gender = gender;
          p.fname = fname;
          p.lname = lname;
          p.height = getQuantityValueAndUnit(height[0]);

          if (typeof systolicbp != 'undefined')  {
            p.systolicbp = systolicbp;
          }

          if (typeof diastolicbp != 'undefined') {
            p.diastolicbp = diastolicbp;
          }

          p.hdl = getQuantityValueAndUnit(hdl[0]);
          p.ldl = getQuantityValueAndUnit(ldl[0]);

          ret.resolve(p);
        });
      } else {
        onError();
      }
    }

    FHIR.oauth2.ready().then(onReady).catch(onError);
    return ret.promise();

  };

  function defaultPatient(){
    return {
      fname: {value: ''},
      lname: {value: ''},
      gender: {value: ''},
      birthdate: {value: ''},
      height: {value: ''},
      systolicbp: {value: ''},
      diastolicbp: {value: ''},
      ldl: {value: ''},
      hdl: {value: ''},
    };
  }

  function getBloodPressureValue(BPObservations, typeOfPressure) {
    var formattedBPObservations = [];
    BPObservations.forEach(function(observation){
      var BP = observation.component.find(function(component){
        return component.code.coding.find(function(coding) {
          return coding.code == typeOfPressure;
        });
      });
      if (BP) {
        observation.valueQuantity = BP.valueQuantity;
        formattedBPObservations.push(observation);
      }
    });

    return getQuantityValueAndUnit(formattedBPObservations[0]);
  }

  function getQuantityValueAndUnit(ob) {
    if (typeof ob != 'undefined' &&
        typeof ob.valueQuantity != 'undefined' &&
        typeof ob.valueQuantity.value != 'undefined' &&
        typeof ob.valueQuantity.unit != 'undefined') {
          return ob.valueQuantity.value + ' ' + ob.valueQuantity.unit;
    } else {
      return undefined;
    }
  }

  window.drawVisualization = function(p) {
    $('#holder').show();
    $('#loading').hide();
    $('#fname').html(p.fname);
    $('#lname').html(p.lname);
    $('#gender').html(p.gender);
    $('#birthdate').html(p.birthdate);
    $('#height').html(p.height);
    $('#systolicbp').html(p.systolicbp);
    $('#diastolicbp').html(p.diastolicbp);
    $('#ldl').html(p.ldl);
    $('#hdl').html(p.hdl);
  };

})(window);
